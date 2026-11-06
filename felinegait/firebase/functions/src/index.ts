import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { beforeUserCreated } from "firebase-functions/v2/identity";
import { logger } from "firebase-functions/v2";
import { PubSub } from "@google-cloud/pubsub";

initializeApp();
const db = getFirestore();
const pubsub = new PubSub();

const JOB_TOPIC = "gait-jobs";
const ALERT_DROP_POINTS = 10; // alert when score falls this much vs the previous session

/** Create a user profile on first sign-in. */
export const onUserCreate = beforeUserCreated(async (event) => {
  const user = event.data;
  if (!user) return;
  await db.doc(`users/${user.uid}`).set({
    name: user.displayName ?? "",
    email: user.email ?? "",
    plan: "free",
    orgIds: [],
    consentResearch: false,
    notificationPrefs: { push: true, email: true },
    createdAt: FieldValue.serverTimestamp(),
  });
});

/**
 * Raw video uploaded → mark session `checking` and queue an inference job.
 * Path: raw/{uid}/{catId}/{sessionId}.mp4
 */
export const onRawVideoUploaded = onObjectFinalized(async (event) => {
  const path = event.data.name;
  if (!path?.startsWith("raw/")) return;

  const [, uid, catId, file] = path.split("/");
  const sessionId = file?.replace(/\.[^.]+$/, "");
  if (!uid || !catId || !sessionId) {
    logger.warn("Unexpected upload path", { path });
    return;
  }

  const sessionRef = db.doc(`cats/${catId}/sessions/${sessionId}`);
  const snap = await sessionRef.get();
  if (!snap.exists || snap.get("status") !== "uploaded") {
    logger.warn("No matching session in 'uploaded' state", { path });
    return;
  }

  await sessionRef.update({
    status: "checking",
    videoPath: path,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await pubsub.topic(JOB_TOPIC).publishMessage({
    json: { bucket: event.data.bucket, path, uid, catId, sessionId },
  });
  logger.info("Queued gait job", { catId, sessionId });
});

/** Session finished → update the cat's latest score and alert on a big drop. */
export const onSessionDone = onDocumentUpdated("cats/{catId}/sessions/{sessionId}", async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.status === "done" || after.status !== "done") return;

  const { catId, sessionId } = event.params;
  const catRef = db.doc(`cats/${catId}`);
  const cat = (await catRef.get()).data();
  if (!cat) return;

  const previous = typeof cat.latestScore === "number" ? cat.latestScore : null;
  await catRef.update({
    latestScore: after.score,
    latestRiskLevel: after.riskLevel,
    latestSessionId: sessionId,
  });

  const dropped = previous !== null && previous - after.score >= ALERT_DROP_POINTS;
  if (!dropped && after.riskLevel !== "see_vet") return;

  const message = dropped
    ? `${cat.name}'s mobility score dropped from ${previous} to ${after.score}.`
    : `${cat.name}'s latest test suggests a vet check.`;

  await db.collection(`notifications/${cat.ownerUid}/items`).add({
    type: dropped ? "score_drop" : "see_vet",
    catId,
    sessionId,
    message,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  const owner = (await db.doc(`users/${cat.ownerUid}`).get()).data();
  const tokens: string[] = owner?.fcmTokens ?? [];
  if (tokens.length && owner?.notificationPrefs?.push !== false) {
    await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: "FelineGait", body: message },
      data: { catId, sessionId },
    });
  }
});
