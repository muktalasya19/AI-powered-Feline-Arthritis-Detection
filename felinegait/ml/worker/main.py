"""Cloud Run worker: receives Pub/Sub push messages and runs the gait pipeline.

Each message: {"bucket", "path", "uid", "catId", "sessionId"}
"""

import base64
import json
import logging
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from google.cloud import firestore, storage

from pipeline import PipelineRejected, run_pipeline

MODEL_VERSION = os.environ.get("MODEL_VERSION", "v0-gbm")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("gait-worker")

app = FastAPI()
db = firestore.Client()
gcs = storage.Client()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_VERSION}


@app.post("/pubsub")
async def pubsub_push(request: Request):
    envelope = await request.json()
    try:
        job = json.loads(base64.b64decode(envelope["message"]["data"]))
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, f"bad message: {exc}") from exc

    session_ref = db.document(f"cats/{job['catId']}/sessions/{job['sessionId']}")
    snap = session_ref.get()
    if not snap.exists or snap.get("status") in ("done", "rejected"):
        return {"skipped": True}  # idempotent on Pub/Sub redelivery

    bucket = gcs.bucket(job["bucket"])
    out_prefix = f"processed/{job['catId']}/{job['sessionId']}"

    with tempfile.TemporaryDirectory() as tmp:
        video = Path(tmp) / "input.mp4"
        bucket.blob(job["path"]).download_to_filename(video)

        def set_status(status: str):
            session_ref.update({"status": status, "updatedAt": firestore.SERVER_TIMESTAMP})

        try:
            result = run_pipeline(video, Path(tmp), on_stage=set_status)
        except PipelineRejected as rej:
            session_ref.update({
                "status": "rejected",
                "rejectReason": str(rej),
                "quality": rej.quality,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
            log.info("rejected %s: %s", job["sessionId"], rej)
            return {"rejected": str(rej)}
        except Exception:
            log.exception("pipeline failed for %s", job["sessionId"])
            raise  # non-2xx → Pub/Sub retries, then dead-letter queue

        for name in ("overlay.mp4", "keypoints.json", "thumb.jpg"):
            local = Path(tmp) / name
            if local.exists():
                bucket.blob(f"{out_prefix}/{name}").upload_from_filename(local)

    batch = db.batch()
    batch.update(session_ref, {
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
    batch.set(session_ref.collection("features").document("summary"), result.features)
    batch.commit()

    log.info("done %s score=%s", job["sessionId"], result.score)
    return {"score": result.score}
