import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/cloudflare-pages";
import { verifyFirebaseToken, type FirebaseUser } from "../lib/auth";
import { Firestore } from "../lib/firestore";
import { ObjectStorage, type StorageEnv } from "../lib/storage";

type Env = StorageEnv & {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  FREE_PLAN_MONTHLY_TESTS: string;
  PLUS_PLAN_MONTHLY_TESTS: string;
  MAX_UPLOAD_MB: string;
};

type Vars = { user: FirebaseUser; db: Firestore; storage: ObjectStorage };

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const OUTPUT_FILES = ["overlay.mp4", "keypoints.json", "thumb.jpg"];

const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api");

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "felinegait-edge" }));

// Every route below needs a verified Firebase user.
app.use("*", async (c, next) => {
  try {
    const user = await verifyFirebaseToken(c.req.header("authorization"), c.env.FIREBASE_PROJECT_ID);
    c.set("user", user);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("db", new Firestore(c.env.FIREBASE_PROJECT_ID, JSON.parse(c.env.FIREBASE_SERVICE_ACCOUNT)));
  c.set("storage", new ObjectStorage(c.env));
  await next();
});

/** Can this user read the cat? Mirrors canReadCat() in firestore.rules. */
function canReadCat(user: FirebaseUser, cat: Record<string, unknown> | null): boolean {
  if (!cat) return false;
  if (cat.ownerUid === user.uid) return true;
  const orgs = user.orgs ?? {};
  if (typeof cat.orgId === "string" && orgs[cat.orgId]) return true;
  const shared = (cat.sharedWith as Record<string, string>) ?? {};
  return Object.keys(shared).some((orgId) => orgs[orgId]);
}

/**
 * POST /api/upload-slot  { catId, contentType }
 * Checks ownership and the monthly plan limit, creates the session in
 * `pending_upload`, and returns a presigned PUT URL for the bucket.
 */
app.post("/upload-slot", async (c) => {
  const { user, db, storage } = c.var;
  const { catId, contentType = "video/mp4" } = await c.req.json<{ catId?: string; contentType?: string }>();
  if (!catId) return c.json({ error: "catId required" }, 400);
  const type = contentType.split(";")[0];
  if (!ALLOWED_VIDEO_TYPES.includes(type)) return c.json({ error: `unsupported video type ${type}` }, 415);

  const cat = await db.get(`cats/${catId}`);
  if (!cat || cat.ownerUid !== user.uid) return c.json({ error: "cat not found" }, 404);

  const profile = await db.get(`users/${user.uid}`);
  const plan = (profile?.plan as string) ?? "free";
  const limit = Number(plan === "free" ? c.env.FREE_PLAN_MONTHLY_TESTS : c.env.PLUS_PLAN_MONTHLY_TESTS);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const used = await db.countSessionsSince(user.uid, monthStart);
  if (used >= limit) return c.json({ error: "monthly test limit reached", used, limit, plan }, 402);

  const sessionId = crypto.randomUUID();
  const ext = type === "video/webm" ? "webm" : type === "video/quicktime" ? "mov" : "mp4";
  const videoKey = `raw/${user.uid}/${catId}/${sessionId}.${ext}`;

  await db.create(`cats/${catId}/sessions`, sessionId, {
    ownerUid: user.uid,
    catId,
    status: "pending_upload",
    videoKey,
    createdAt: new Date(),
  });

  return c.json({
    sessionId,
    uploadUrl: await storage.presignPut(videoKey, type),
    contentType: type,
    remainingThisMonth: limit - used - 1,
  });
});

/**
 * POST /api/sessions/:catId/:sessionId/complete
 * Called after the browser finishes the PUT. Confirms the file is in the bucket,
 * then queues the session for the worker (replaces the Storage trigger).
 */
app.post("/sessions/:catId/:sessionId/complete", async (c) => {
  const { user, db, storage } = c.var;
  const { catId, sessionId } = c.req.param();
  const path = `cats/${catId}/sessions/${sessionId}`;

  const session = await db.get(path);
  if (!session || session.ownerUid !== user.uid) return c.json({ error: "session not found" }, 404);
  if (session.status !== "pending_upload") return c.json({ status: session.status });

  const size = await storage.head(session.videoKey as string);
  if (size === null) return c.json({ error: "upload not found in storage" }, 409);
  if (size > Number(c.env.MAX_UPLOAD_MB) * 1024 * 1024) {
    await db.update(path, { status: "rejected", rejectReason: `Video is larger than ${c.env.MAX_UPLOAD_MB} MB.` });
    return c.json({ error: "file too large" }, 413);
  }

  await db.update(path, { status: "queued", sizeBytes: size, queuedAt: new Date() });
  return c.json({ status: "queued" });
});

/**
 * GET /api/media/:catId/:sessionId/:file
 * Short-lived URL for a worker output (overlay video, keypoints, thumbnail).
 */
app.get("/media/:catId/:sessionId/:file", async (c) => {
  const { user, db, storage } = c.var;
  const { catId, sessionId, file } = c.req.param();
  if (!OUTPUT_FILES.includes(file)) return c.json({ error: "unknown file" }, 400);

  const cat = await db.get(`cats/${catId}`);
  if (!canReadCat(user, cat)) return c.json({ error: "not found" }, 404);

  const url = await storage.presignGet(`processed/${catId}/${sessionId}/${file}`);
  return c.json({ url });
});

/**
 * POST /api/share  { catId, expiresInDays? }
 * Owner creates a one-time invite token a clinic can accept.
 */
app.post("/share", async (c) => {
  const { user, db } = c.var;
  const { catId, expiresInDays = 14 } = await c.req.json<{ catId?: string; expiresInDays?: number }>();
  if (!catId) return c.json({ error: "catId required" }, 400);

  const cat = await db.get(`cats/${catId}`);
  if (!cat || cat.ownerUid !== user.uid) return c.json({ error: "cat not found" }, 404);

  const token = crypto.randomUUID().replace(/-/g, "");
  await db.create("shareInvites", token, {
    catId,
    fromUid: user.uid,
    expiresAt: new Date(Date.now() + expiresInDays * 864e5),
  });
  return c.json({ token, url: `${new URL(c.req.url).origin}/share/${token}` });
});

/**
 * POST /api/share/:token/accept  { orgId }
 * A vet accepts an invite on behalf of one of their orgs.
 */
app.post("/share/:token/accept", async (c) => {
  const { user, db } = c.var;
  const token = c.req.param("token");
  const { orgId } = await c.req.json<{ orgId?: string }>();
  if (!orgId || user.orgs?.[orgId] !== "vet") return c.json({ error: "must be a vet in that org" }, 403);

  const invite = await db.get(`shareInvites/${token}`);
  if (!invite || invite.acceptedAt) return c.json({ error: "invite not found or used" }, 404);
  if (new Date(invite.expiresAt as string) < new Date()) return c.json({ error: "invite expired" }, 410);

  const catId = invite.catId as string;
  const cat = await db.get(`cats/${catId}`);
  const sharedWith = { ...((cat?.sharedWith as Record<string, string>) ?? {}), [orgId]: "vet" };
  await db.update(`cats/${catId}`, { sharedWith });
  await db.update(`shareInvites/${token}`, { acceptedAt: new Date(), toOrgId: orgId });

  return c.json({ catId, orgId });
});

export const onRequest = handle(app);
