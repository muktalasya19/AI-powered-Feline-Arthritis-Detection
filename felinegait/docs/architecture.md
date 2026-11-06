# FelineGait architecture

Full write-up with diagrams: https://claude.ai/artifact/8ehanSYmxaQxE1gey8W9F2

## Layers (free stack)

```
Clients (Owner PWA · Vet portal · Shelter console · Admin)
   │ load app, call API                     │ Firebase SDK: sign-in, live status
   ▼                                        │
Cloudflare Pages + Pages Functions          │
   │ presigned PUT/GET   │ Firestore REST   │
   ▼                     ▼                  ▼
R2 / B2 bucket      Firebase Spark: Auth · Firestore · FCM
   ▲                     ▲
   │ download video,     │ poll `queued`, claim, write results
   │ upload outputs      │
   └──── Polling worker (your PC · Colab · Kaggle) ────┘
```

## Session status machine

`pending_upload` (edge API) → `queued` (edge API, after upload confirmed) → `checking` (worker claims) → `processing` → `done` | `rejected`

A worker that crashes mid-job leaves a session in `checking`/`processing`; any worker requeues it after 20 minutes. Failed jobs retry up to 3 times.

## Firestore

| Path | Written by |
| --- | --- |
| `users/{uid}` | App on first sign-in (free plan only); user edits name/prefs |
| `orgs/{orgId}`, `orgs/{orgId}/members/{uid}` | Server only |
| `cats/{catId}` | Owner (except `sharedWith`, `orgId`, `latest*`) |
| `cats/{catId}/sessions/{sessionId}` | Edge API creates and queues; worker updates |
| `.../sessions/{id}/features/summary` | Worker |
| `.../sessions/{id}/annotations/{id}` | Vets |
| `cats/{catId}/questionnaires`, `events` | Owner |
| `shareInvites/{token}` | Edge API |
| `models/{version}` | Admin / training jobs |
| `notifications/{uid}/items` | Worker |
| `auditLog` | Server only |

## Bucket (R2 or B2)

- `raw/{uid}/{catId}/{sessionId}.{mp4|webm|mov}` — browser upload via presigned PUT, ≤ 200 MB
- `processed/{catId}/{sessionId}/` — `overlay.mp4`, `keypoints.json`, `thumb.jpg`
- `reports/{catId}/{sessionId}.pdf`

## Roadmap

| Phase | Weeks | Gate to exit |
| --- | --- | --- |
| 0 Foundations | 1–2 | — |
| 1 ML baseline | 1–6 | v0 AUC ≥ 0.70, < 2 min/video |
| 2 Owner MVP | 3–8 | 20 beta owners, 80% pass quality gate |
| 3 Clinical | 9–12 | Partner clinic labelling, v1 AUC ≥ 0.80 |
| 4 SaaS | 13–16 | 3 orgs piloting |
| 5 Scale | 17+ | — |
