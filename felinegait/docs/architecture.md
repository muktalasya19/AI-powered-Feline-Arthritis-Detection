# FelineGait architecture

Full write-up with diagrams: https://claude.ai/artifact/8ehanSYmxaQxE1gey8W9F2

## Layers

```
Clients (Owner PWA · Vet portal · Shelter console · Admin)
   │  load app, call API                    │ Firebase SDK: sign-in, live status, uploads
   ▼                                        │
Cloudflare edge                             │
   Pages (React SPA) · Pages Functions API · Turnstile + WAF
   │  Admin writes (Firestore REST)         │
   ▼                                        ▼
Firebase: Auth · Firestore · Cloud Storage · Cloud Functions + FCM
   │  upload event (Pub/Sub)        ▲ scores, features, overlays written back
   ▼                                │
Google Cloud: Pub/Sub → Cloud Run GPU worker → Model registry
```

## Session status machine

`uploaded` (edge API) → `checking` (Storage trigger) → `processing` (worker) → `done` | `rejected`

## Firestore

| Path | Written by |
| --- | --- |
| `users/{uid}` | Auth trigger; user edits name/prefs |
| `orgs/{orgId}`, `orgs/{orgId}/members/{uid}` | Server only |
| `cats/{catId}` | Owner (except `sharedWith`, `orgId`, `latest*`) |
| `cats/{catId}/sessions/{sessionId}` | Edge API creates; worker and functions update |
| `.../sessions/{id}/features/summary` | Worker |
| `.../sessions/{id}/annotations/{id}` | Vets |
| `cats/{catId}/questionnaires`, `events` | Owner |
| `shareInvites/{token}` | Edge API |
| `models/{version}` | Admin / training jobs |
| `notifications/{uid}/items` | Functions |
| `auditLog` | Server only |

## Storage

- `raw/{uid}/{catId}/{sessionId}.mp4` — client upload, ≤ 200 MB, video only
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
