# FelineGait

Screening and monitoring of feline mobility from a short phone video of a cat walking.
FelineGait is a **screening aid, not a diagnosis**.

## Architecture

| Layer | What lives here | Folder |
| --- | --- | --- |
| Frontend | React + Vite + TypeScript + Tailwind, deployed to **Cloudflare Pages** | `apps/web` |
| Edge API | **Pages Functions** (Hono): verifies Firebase ID tokens, upload slots, plan limits | `apps/web/functions` |
| Backend | **Firebase** Auth, Firestore, Cloud Storage, Cloud Functions (upload trigger to Pub/Sub) | `firebase` |
| ML inference | **Cloud Run** GPU worker (Python, DeepLabCut, PyTorch, scikit-learn) | `ml/worker` |
| CI/CD | GitHub Actions | `.github/workflows` |

Flow for one test:

1. Owner records a video in the app.
2. App calls `POST /api/upload-slot` → edge checks the plan limit and creates `cats/{catId}/sessions/{sessionId}` with status `uploaded`.
3. App uploads the video to `raw/{uid}/{catId}/{sessionId}.mp4` in Cloud Storage.
4. Storage trigger (Cloud Function) sets status `checking` and publishes a job to Pub/Sub topic `gait-jobs`.
5. Cloud Run worker runs quality gate → pose estimation → features → scoring, then writes results back to Firestore.
6. App's Firestore listener shows progress and the result live.

See `docs/architecture.md` for the data model and roadmap.

## Getting started

### Prerequisites

- Node.js 20+, npm 10+
- Firebase CLI: `npm i -g firebase-tools`
- Wrangler (Cloudflare CLI): installed as a dev dependency
- Google Cloud SDK (`gcloud`) for the ML worker
- Python 3.11 for the worker

### 1. Install

```bash
npm install
```

### 2. Configure Firebase

1. Create a Firebase project and enable Auth (Google + Email link), Firestore and Storage.
2. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in your web app config.
3. Set your project ID in `.firebaserc`.
4. Create the Pub/Sub topic and deploy rules, indexes and functions (from the repo root):

```bash
gcloud pubsub topics create gait-jobs
firebase deploy --only firestore,storage,functions
```

5. For the edge API, copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` and add a service account with the "Cloud Datastore User" role.

### 3. Run the web app locally

```bash
npm run dev            # Vite dev server
npm run dev:pages      # Vite build + Pages Functions via wrangler
```

### 4. Deploy the web app to Cloudflare Pages

```bash
npm run build -w apps/web
npx wrangler pages deploy apps/web/dist --project-name felinegait
```

Set `FIREBASE_PROJECT_ID` as an environment variable in the Pages project settings.

### 5. Deploy the ML worker

```bash
cd ml/worker
gcloud run deploy gait-worker --source . --region europe-west4 \
  --gpu 1 --gpu-type nvidia-l4 --cpu 4 --memory 16Gi --no-allow-unauthenticated
gcloud pubsub subscriptions create gait-jobs-push --topic gait-jobs \
  --push-endpoint=https://<worker-url>/pubsub --push-auth-service-account=<sa-email>
```

## Repo layout

```
apps/web/                React app + Pages Functions
  functions/api/         Edge API (Hono)
  src/                   App source
firebase/                Rules, indexes, Cloud Functions
ml/worker/               Cloud Run inference worker
docs/                    Architecture and roadmap
.github/workflows/       CI/CD
```

## Roadmap

| Phase | Weeks | Scope |
| --- | --- | --- |
| 0 Foundations | 1–2 | Repo, Firebase, Pages, auth, CI |
| 1 ML baseline | 1–6 | DeepLabCut fine-tune, features, v0 model, Cloud Run worker |
| 2 Owner MVP | 3–8 | Profiles, recorder, upload, results, trends |
| 3 Clinical | 9–12 | Vet sharing, portal, PDF, questionnaire, labeling, v1 model |
| 4 SaaS | 13–16 | Orgs, roles, Stripe, shelter batch mode, admin |
| 5 Scale | 17+ | Validation study, public API, native apps |
