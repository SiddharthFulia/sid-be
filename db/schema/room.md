# Schema — Room Designer (V2)

Source: `services/aiVideo/db.js`.

Two phases per session share one row: **analyze** (synchronous on BE, ~10-15 s)
and **render** (async via `room_queue` on 5090 worker). When the user picks
items and hits render, the existing row is `UPDATE`d — no new row inserted.

## `room_jobs`

| Column | Type | Purpose |
|---|---|---|
| `jobId` | TEXT PK | uuid |
| `status` | TEXT NOT NULL | `analyzed` \| `rendering` \| `completed` \| `failed` |
| `sourceVideoUrl` | TEXT | Cloudinary URL of uploaded sweep |
| `sourcePublicId` | TEXT | Cloudinary public_id |
| `analysisJson` | TEXT | JSON `{roomType, toneNotes, detected, missing, spaceGapPct}` |
| `keyframeUrls` | TEXT | JSON array of Cloudinary URLs |
| `pickedItemsJson` | TEXT | JSON array of selected catalog items |
| `mp4Url` `mp4PublicId` | | Cloudinary final render |
| `error` `workerId` `progressMessage` `elapsedMs` | | |
| `createdAt` `analyzedAt` `renderStartedAt` `renderCompletedAt` | TEXT | |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_room_status_created` | `(status, createdAt DESC)` | Library + status polling |
| **NEW** `idx_room_worker_status` | `(workerId, status)` | worker debug |
