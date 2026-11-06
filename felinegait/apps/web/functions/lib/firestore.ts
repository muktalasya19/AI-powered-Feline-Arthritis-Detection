import { SignJWT, importPKCS8 } from "jose";

/**
 * Minimal Firestore REST client for the edge (the Admin SDK does not run on Workers).
 * Authenticates with a service account via the OAuth JWT-bearer flow.
 */
interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;

  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in };
  return json.access_token;
}

type Value =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { mapValue: { fields: Record<string, Value> } };

export function toFields(obj: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) out[k] = { nullValue: null };
    else if (v instanceof Date) out[k] = { timestampValue: v.toISOString() };
    else if (typeof v === "string") out[k] = { stringValue: v };
    else if (typeof v === "boolean") out[k] = { booleanValue: v };
    else if (typeof v === "number") out[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (typeof v === "object") out[k] = { mapValue: { fields: toFields(v as Record<string, unknown>) } };
  }
  return out;
}

export function fromFields(fields: Record<string, any> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if ("stringValue" in v) out[k] = v.stringValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("doubleValue" in v) out[k] = v.doubleValue;
    else if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("timestampValue" in v) out[k] = v.timestampValue;
    else if ("mapValue" in v) out[k] = fromFields(v.mapValue.fields);
    else out[k] = null;
  }
  return out;
}

export class Firestore {
  private base: string;
  constructor(private projectId: string, private sa: ServiceAccount) {
    this.base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  }

  private async headers() {
    return { authorization: `Bearer ${await accessToken(this.sa)}`, "content-type": "application/json" };
  }

  async get(path: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.base}/${path}`, { headers: await this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`firestore get ${path}: ${res.status}`);
    const doc = (await res.json()) as { fields?: Record<string, unknown> };
    return fromFields(doc.fields as Record<string, any>);
  }

  async create(collectionPath: string, id: string, data: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.base}/${collectionPath}?documentId=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ fields: toFields(data) }),
    });
    if (!res.ok) throw new Error(`firestore create ${collectionPath}/${id}: ${res.status}`);
  }

  async update(path: string, data: Record<string, unknown>): Promise<void> {
    const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
    const res = await fetch(`${this.base}/${path}?${mask}`, {
      method: "PATCH",
      headers: await this.headers(),
      body: JSON.stringify({ fields: toFields(data) }),
    });
    if (!res.ok) throw new Error(`firestore update ${path}: ${res.status}`);
  }

  /** Count sessions a user created since a date (for plan limits). */
  async countSessionsSince(uid: string, since: Date): Promise<number> {
    const res = await fetch(`${this.base}:runAggregationQuery`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({
        structuredAggregationQuery: {
          aggregations: [{ alias: "n", count: {} }],
          structuredQuery: {
            from: [{ collectionId: "sessions", allDescendants: true }],
            where: {
              compositeFilter: {
                op: "AND",
                filters: [
                  { fieldFilter: { field: { fieldPath: "ownerUid" }, op: "EQUAL", value: { stringValue: uid } } },
                  { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: since.toISOString() } } },
                ],
              },
            },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`firestore count: ${res.status}`);
    const rows = (await res.json()) as Array<{ result?: { aggregateFields?: { n?: { integerValue: string } } } }>;
    return Number(rows[0]?.result?.aggregateFields?.n?.integerValue ?? 0);
  }
}
