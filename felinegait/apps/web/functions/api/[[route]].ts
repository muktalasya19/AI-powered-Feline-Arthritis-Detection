import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/cloudflare-pages";
import { verifyFirebaseToken, type FirebaseUser } from "../lib/auth";
import { Firestore } from "../lib/firestore";

type Env = {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  FREE_PLAN_MONTHLY_TESTS: string;
  PLUS_PLAN_MONTHLY_TESTS: string;
};

type Vars = { user: FirebaseUser; db: Firestore };

const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api");

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "felinegait-edge" }));

// Every route below needs a verified Firebase user.
app.use("*", async (c, next) => {
  try {
    const user = await verifyFirebaseToken(c.req.header("authorization"), c.env.FIREBASE_PROJECT_ID);
    c.set("user", user);
    c.set("db", new Firestore(c.env.FIREBASE_PROJECT_ID, JSON.parse(c.env.FIREBASE_SERVICE_ACCOUNT)));
    await next();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
});

/**
 * POST /api/upload-slot  { catId }
 * Checks ownership and the monthly plan limit, then creates the session doc in
 * `uploaded` status. Returns the Storage path the client must upload to.
 */
app.post("/upload-slot", async (c) => {
  const { user, db } = c.var;
  const { catId } = await c.req.json<{ catId?: string }>();
  if (!catId) return c.json({ error: "catId required" }, 400);

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
  await db.create(`cats/${catId}/sessions`, sessionId, {
    ownerUid: user.uid,
    status: "uploaded",
    createdAt: new Date(),
  });

  return c.json({
    sessionId,
    uploadPath: `raw/${user.uid}/${catId}/${sessionId}.mp4`,
    remainingThisMonth: limit - used - 1,
  });
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
