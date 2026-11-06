# FelineGait

Screening and monitoring of feline mobility from a short phone video of a cat walking.
FelineGait is a **screening aid, not a diagnosis**.

This version runs entirely on **free tiers** — no Firebase Blaze plan, no Cloud Run.

## Architecture (free stack)

| Layer | Service | Free allowance | Folder |
| --- | --- | --- | --- |
| Frontend | **Cloudflare Pages** (React + Vite + Tailwind) | Unlimited static requests | `apps/web` |
| Edge API | **Pages Functions** (Hono) | 100,000 requests/day | `apps/web/functions` |
| Auth + database | **Firebase Spark**: Auth, Firestore | 50K MAU; 1 GiB, 50K reads / 20K writes per day | `firebase` |
| Video storage | **Cloudflare R2** or **Backblaze B2** (S3-compatible) | 10 GB each, R2 egress free | `infra` |
| ML worker | Polling worker on **your PC, Google Colab or Kaggle** | Your own machine / free notebook GPU time | `ml/worker` |
| CI/CD | GitHub Actions | 2,000 min/month on private repos | `.github/workflows` |

What changed from the paid design, and why:

| Paid piece | Free replacement |
| --- | --- |
| Firebase Storage (Blaze only since Feb 2026) | R2 / B2 bucket, uploads via presigned URLs from the edge API |
| Cloud Functions (Blaze only) | Edge API endpoints + the worker do the same jobs |
| Auth trigger that creates the user profile | The app creates `users/{uid}` on first sign-in (rules restrict it to the free plan) |
| Storage trigger → Pub/Sub | `POST /api/sessions/:catId/:id/complete` marks the session `queued` |
| Cloud Run GPU worker | `worker.py` polls Firestore for `queued` sessions and claims them in a transaction |
| `onSessionDone` alert function | Done by the worker after it writes the result |

Flow for one test:

1. Owner records a video in the app.
2. `POST /api/upload-slot` → edge checks the plan limit, creates the session (`pending_upload`) and returns a presigned PUT URL.
3. The browser uploads the video straight to the bucket.
4. `POST /api/sessions/:catId/:sessionId/complete` → edge confirms the file exists and sets `queued`.
5. The worker claims it (`checking` → `processing`), runs the pipeline, uploads outputs to `processed/…` and writes the score (`done` or `rejected`).
6. The app's Firestore listener shows each step live. Videos wait safely in `queued` if no worker is running.

## Setup

### Prerequisites

- Node.js 20+, Python 3.11
- Firebase CLI: `npm i -g firebase-tools`
- A Cloudflare account (free) and a Firebase project on the **Spark** (free) plan

### 1. Firebase (Spark plan)

1. Create a project at console.firebase.google.com. Stay on Spark.
2. Authentication → enable **Google**.
3. Firestore → create the database (any region).
4. Project settings → Your apps → add a **Web app**; copy the config into `apps/web/.env.local` (start from `.env.example`).
5. Project settings → Service accounts → **Generate new private key** → save as `service-account.json` (never commit it; it's in `.gitignore`).
6. Put your project ID in `.firebaserc` and in `apps/web/wrangler.toml`, then deploy rules and indexes:

```bash
firebase login
firebase deploy --only firestore
```

### 2. Video bucket

**Option A — Cloudflare R2** (same account as Pages; Cloudflare may ask for a payment method to enable R2, but usage inside the free tier is $0):

1. Cloudflare dashboard → R2 → **Create bucket** `felinegait-media`.
2. Bucket → Settings → **CORS policy** → paste `infra/bucket-cors.json` (add your custom domain later).
3. R2 → **Manage API tokens** → create a token with *Object Read & Write* on that bucket. Note the Access Key ID, Secret and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

**Option B — Backblaze B2** (10 GB free, no card needed):

1. Create a private bucket `felinegait-media`; note its S3 endpoint `https://s3.<region>.backblazeb2.com`.
2. Set CORS with the B2 CLI or the bucket settings using `infra/bucket-cors.json`.
3. App Keys → add a key with read/write on that bucket.

Put the endpoint, region (`auto` for R2, the B2 region otherwise) and bucket name in `apps/web/wrangler.toml`.

### 3. Web app + edge API on Cloudflare Pages

```bash
npm install
cd apps/web
npx wrangler login
npx wrangler pages project create felinegait --production-branch main

# Secrets (stored encrypted in Cloudflare, never in git)
npx wrangler pages secret put FIREBASE_SERVICE_ACCOUNT --project-name felinegait < ../../service-account.json
npx wrangler pages secret put S3_ACCESS_KEY_ID --project-name felinegait
npx wrangler pages secret put S3_SECRET_ACCESS_KEY --project-name felinegait

npm run build
npx wrangler pages deploy dist --project-name felinegait
```

Then Firebase → Authentication → Settings → **Authorized domains** → add `felinegait.pages.dev`.

Local development: copy `.dev.vars.example` to `.dev.vars`, then `npm run dev:pages` (app + API on http://localhost:8788).

### 4. Run the ML worker (free)

**On your own computer:**

```bash
cd ml/worker
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install "deeplabcut==3.0.0"
cp .env.example .env        # fill in values, then:
set -a && source .env && set +a
python worker.py            # polls every 15 s; Ctrl+C to stop
```

CPU is fine for a pilot: a 20-second clip takes a few minutes. With Docker instead: `docker build -t felinegait-worker ml/worker && docker run --env-file ml/worker/.env -v $PWD/service-account.json:/app/service-account.json felinegait-worker`.

**On a free GPU:** see `ml/worker/run_in_colab.md` (Google Colab or Kaggle). Good for clearing a backlog quickly.

### 5. Automatic deploys (optional)

Add these GitHub repo secrets and every push to `main` deploys; every PR gets a preview URL:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, the five `VITE_FIREBASE_*` values, and `FIREBASE_SERVICE_ACCOUNT` (for rules/indexes).

## Free-tier limits to watch

- **Firestore**: 50K reads/day. An idle worker polling every 15 s uses ~5.8K; raise `POLL_SECONDS` if you need headroom. If a quota is exceeded, Firebase stops that product until the quota resets.
- **Bucket**: 10 GB ≈ 500–1,000 test videos. Delete raw videos after processing for users without research consent.
- **Worker availability**: results only arrive while a worker is running. When you outgrow this, deploy the same worker to a paid always-on host — no app changes needed.

## Repo layout

```
apps/web/                React app + Pages Functions (edge API)
  functions/api/         Routes: upload-slot, complete, media, share
  functions/lib/         Firebase token check, Firestore REST, S3 presigning
firebase/                Firestore rules and indexes
infra/                   Bucket CORS policy
ml/worker/               Polling worker + gait pipeline
docs/                    Architecture and roadmap
```
