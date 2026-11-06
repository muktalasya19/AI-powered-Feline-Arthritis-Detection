"""FelineGait polling worker — runs anywhere for free (your laptop, Google Colab, Kaggle).

Instead of Pub/Sub + Cloud Run (paid), this loop asks Firestore for sessions in
`queued` status, claims one in a transaction, runs the gait pipeline, uploads the
outputs to the S3-compatible bucket and writes the result back. The web app's
Firestore listener shows progress live, so nothing else changes for the user.

Run:
    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
    export S3_ENDPOINT=... S3_REGION=auto S3_BUCKET=felinegait-media
    export S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
    python worker.py            # poll forever
    python worker.py --once     # drain the queue, then exit (cron / Colab cell)
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
import firebase_admin
from firebase_admin import firestore, messaging
from google.cloud.firestore_v1 import FieldFilter, Transaction

from pipeline import PipelineRejected, run_pipeline

MODEL_VERSION = os.environ.get("MODEL_VERSION", "v0-heuristic")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "15"))  # ~5.8k reads/day when idle; Spark allows 50k
STALE_MINUTES = int(os.environ.get("STALE_MINUTES", "20"))  # requeue jobs a crashed worker left behind
ALERT_DROP_POINTS = 10
OUTPUT_FILES = ("overlay.mp4", "keypoints.json", "thumb.jpg")
WORKER_ID = os.environ.get("WORKER_ID", socket.gethostname())

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gait-worker")

firebase_admin.initialize_app()
db = firestore.client()
s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["S3_ENDPOINT"],
    region_name=os.environ.get("S3_REGION", "auto"),
    aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
)
BUCKET = os.environ["S3_BUCKET"]


# --------------------------------------------------------------------------- #
# Queue
# --------------------------------------------------------------------------- #
def next_queued():
    docs = (
        db.collection_group("sessions")
        .where(filter=FieldFilter("status", "==", "queued"))
        .order_by("createdAt")
        .limit(1)
        .get()
    )
    return docs[0].reference if docs else None


@firestore.transactional
def claim(tx: Transaction, ref) -> bool:
    snap = ref.get(transaction=tx)
    if not snap.exists or snap.get("status") != "queued":
        return False  # another worker got it first
    tx.update(ref, {
        "status": "checking",
        "claimedBy": WORKER_ID,
        "claimedAt": firestore.SERVER_TIMESTAMP,
    })
    return True


def requeue_stale() -> None:
    """Put back jobs stuck in checking/processing longer than STALE_MINUTES."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=STALE_MINUTES)
    for status in ("checking", "processing"):
        stuck = (
            db.collection_group("sessions")
            .where(filter=FieldFilter("status", "==", status))
            .where(filter=FieldFilter("claimedAt", "<", cutoff))
            .limit(10)
            .get()
        )
        for doc in stuck:
            log.warning("requeueing stale session %s (claimed by %s)", doc.id, doc.get("claimedBy"))
            doc.reference.update({"status": "queued"})


# --------------------------------------------------------------------------- #
# One job
# --------------------------------------------------------------------------- #
def process(ref) -> None:
    session = ref.get().to_dict()
    cat_id = ref.parent.parent.id
    session_id = ref.id
    out_prefix = f"processed/{cat_id}/{session_id}"
    log.info("processing %s for cat %s", session_id, cat_id)

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        video = tmpdir / f"input{Path(session['videoKey']).suffix}"
        s3.download_file(BUCKET, session["videoKey"], str(video))

        def set_status(status: str) -> None:
            ref.update({"status": status, "updatedAt": firestore.SERVER_TIMESTAMP})

        try:
            result = run_pipeline(video, tmpdir, on_stage=set_status)
        except PipelineRejected as rej:
            ref.update({
                "status": "rejected",
                "rejectReason": str(rej),
                "quality": rej.quality,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
            log.info("rejected %s: %s", session_id, rej)
            return

        for name in OUTPUT_FILES:
            local = tmpdir / name
            if local.exists():
                s3.upload_file(str(local), BUCKET, f"{out_prefix}/{name}")

    batch = db.batch()
    batch.update(ref, {
        "status": "done",
        "score": result.score,
        "confidence": result.confidence,
        "riskLevel": result.risk_level,
        "features": result.features,
        "quality": result.quality,
        "modelVersion": MODEL_VERSION,
        "outputs": {"prefix": out_prefix},
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })
    batch.set(ref.collection("features").document("summary"), result.features)
    batch.commit()
    log.info("done %s score=%s", session_id, result.score)

    update_cat_and_alert(cat_id, session_id, result.score, result.risk_level)


def update_cat_and_alert(cat_id: str, session_id: str, score: int, risk: str) -> None:
    """Replaces the onSessionDone Cloud Function."""
    cat_ref = db.document(f"cats/{cat_id}")
    cat = cat_ref.get().to_dict() or {}
    previous = cat.get("latestScore")
    cat_ref.update({"latestScore": score, "latestRiskLevel": risk, "latestSessionId": session_id})

    dropped = isinstance(previous, (int, float)) and previous - score >= ALERT_DROP_POINTS
    if not dropped and risk != "see_vet":
        return

    name = cat.get("name", "Your cat")
    message = (
        f"{name}'s mobility score dropped from {previous} to {score}."
        if dropped else f"{name}'s latest test suggests a vet check."
    )
    db.collection(f"notifications/{cat['ownerUid']}/items").add({
        "type": "score_drop" if dropped else "see_vet",
        "catId": cat_id,
        "sessionId": session_id,
        "message": message,
        "read": False,
        "createdAt": firestore.SERVER_TIMESTAMP,
    })

    owner = db.document(f"users/{cat['ownerUid']}").get().to_dict() or {}
    tokens = owner.get("fcmTokens") or []
    if tokens and owner.get("notificationPrefs", {}).get("push", True):
        # FCM is free on the Spark plan.
        messaging.send_each_for_multicast(messaging.MulticastMessage(
            tokens=tokens,
            notification=messaging.Notification(title="PurrStride", body=message),
            data={"catId": cat_id, "sessionId": session_id},
        ))


def mark_failed(ref, exc: Exception) -> None:
    attempts = (ref.get().get("attempts") or 0) + 1
    if attempts >= 3:
        ref.update({"status": "rejected", "rejectReason": "We hit an error analysing this video. Please try again.",
                    "attempts": attempts, "lastError": str(exc)[:500]})
    else:
        ref.update({"status": "queued", "attempts": attempts, "lastError": str(exc)[:500]})


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def drain() -> int:
    handled = 0
    while (ref := next_queued()) is not None:
        if not claim(db.transaction(), ref):
            continue
        try:
            process(ref)
        except Exception as exc:  # keep the worker alive; retry up to 3 times
            log.exception("failed %s", ref.id)
            mark_failed(ref, exc)
        handled += 1
    return handled


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="process the queue once and exit")
    args = parser.parse_args()

    log.info("worker %s started (model %s)", WORKER_ID, MODEL_VERSION)
    last_stale_check = 0.0
    while True:
        if time.time() - last_stale_check > 300:
            requeue_stale()
            last_stale_check = time.time()
        handled = drain()
        if args.once:
            log.info("handled %d job(s); exiting", handled)
            return
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
