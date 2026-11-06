import { AwsClient } from "aws4fetch";

/**
 * S3-compatible object storage (Cloudflare R2 or Backblaze B2, both with free tiers).
 * The browser never gets bucket credentials: it receives short-lived presigned URLs.
 */
export interface StorageEnv {
  S3_ENDPOINT: string; // R2: https://<account-id>.r2.cloudflarestorage.com · B2: https://s3.<region>.backblazeb2.com
  S3_REGION: string; // R2: "auto" · B2: e.g. "us-west-004"
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
}

export class ObjectStorage {
  private client: AwsClient;
  private base: string;

  constructor(env: StorageEnv) {
    this.client = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      service: "s3",
      region: env.S3_REGION,
    });
    this.base = `${env.S3_ENDPOINT.replace(/\/$/, "")}/${env.S3_BUCKET}`;
  }

  private url(key: string, expiresIn: number) {
    const u = new URL(`${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`);
    u.searchParams.set("X-Amz-Expires", String(expiresIn));
    return u;
  }

  /** Presigned PUT the browser can upload to directly. */
  async presignPut(key: string, contentType: string, expiresIn = 900): Promise<string> {
    const req = await this.client.sign(new Request(this.url(key, expiresIn), {
      method: "PUT",
      headers: { "content-type": contentType },
    }), { aws: { signQuery: true } });
    return req.url;
  }

  /** Presigned GET for playback or download. */
  async presignGet(key: string, expiresIn = 3600): Promise<string> {
    const req = await this.client.sign(new Request(this.url(key, expiresIn), { method: "GET" }), {
      aws: { signQuery: true },
    });
    return req.url;
  }

  /** Size in bytes, or null if the object does not exist. */
  async head(key: string): Promise<number | null> {
    const res = await this.client.fetch(`${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`, {
      method: "HEAD",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage head ${key}: ${res.status}`);
    return Number(res.headers.get("content-length") ?? 0);
  }
}
