# Schema — AI Video lane

Source: `services/aiVideo/db.js`. WAL mode, foreign keys ON.

## `jobs` — in-flight + completed video generations

Every video generation request. Row transitions
`queued → processing → completed | failed`. The FE polls
`GET /api/ai-video/status/:videoId` off this table.

| Column | Type | Purpose |
|---|---|---|
| `videoId` | TEXT PK | uuid v4 |
| `provider` | TEXT | worker role: `worker` \| `local` |
| `originalProvider` | TEXT | FE label: `optimized` \| `local` \| `worker` \| `zsky` |
| `status` | TEXT | `queued` \| `processing` \| `completed` \| `failed` |
| `prompt` | TEXT | user prompt |
| `model` | TEXT | ltx-video / wan-2.1 / wan-2.2 / hunyuan / mochi / svd / etc. |
| `duration` | INTEGER | seconds |
| `resolution` | TEXT | e.g. `720p` |
| `aspectRatio` | TEXT | `16:9` \| `9:16` \| `1:1` |
| `steps` | INTEGER | sampler steps |
| `style` | TEXT | free-form style tag |
| `audio` | INTEGER | 0/1 boolean |
| `imageUrl` | TEXT | I2V source frame (Cloudinary) |
| `generateCaption` | INTEGER | 0/1 |
| `attemptCount` | INTEGER | retries so far |
| `createdAt` `startedAt` `completedAt` | TEXT | ISO |
| `videoUrl` | TEXT | Cloudinary output |
| `caption` | TEXT | Groq-generated caption |
| `error` | TEXT | last error msg |
| `workerId` | TEXT | which worker took the job |
| `estimatedSeconds` | INTEGER | worker's ETA at boot |
| `progressMessage` `progressStep` `progressTotal` | | live progress |
| `logs` | TEXT | JSON array `[{ts,msg}]` (legacy — new lines go via `job_logs`) |
| `withMusic` | INTEGER | 0/1 |
| `musicPrompt` | TEXT | MusicGen prompt |
| `vault` | INTEGER | 0/1 — hides row from anon library |
| `seed` | INTEGER | locked sampler seed (Cinema) |
| `motionStrength` | REAL | 0.1..1.0 (Wan/Hunyuan/SVD) |
| `negativePrompt` | TEXT | passed to worker's negative CLIPTextEncode |
| `continuityFrameTime` | REAL | source-frame offset from prev clip (Cinema) |

### Indexes

| Name | Columns | Query it serves |
|---|---|---|
| `idx_jobs_status_provider` | `(status, provider)` | worker `next-job` scan |
| `idx_jobs_createdAt` | `(createdAt DESC)` | admin list |
| `idx_jobs_origProvider` | `(originalProvider)` | provider filter |
| `idx_jobs_origProv_created` | `(originalProvider, createdAt DESC)` | Library provider tab |
| `idx_jobs_status_created` | `(status, createdAt DESC)` | Failures / Jobs tab |
| `idx_jobs_model` | `(model)` | admin model breakdown |
| **NEW** `idx_jobs_vault_created` | `(vault, createdAt DESC)` | anon Library `WHERE vault=0` |

## `videos` — completed Cloudinary records

Denormalized library table (mirrors `jobs` minus the ephemeral state) so the
Library tab list doesn't scan `jobs` and pay the Cloudinary Search-API tax.

| Column | Type | Purpose |
|---|---|---|
| `videoId` | TEXT PK | matches `jobs.videoId` |
| `publicId` | TEXT | Cloudinary public_id |
| `videoUrl` | TEXT | Cloudinary URL |
| `prompt` `provider` `model` `duration` `aspectRatio` `resolution` `style` `audio` `caption` `bytes` | | Library card fields |
| `createdAt` | TEXT | ISO |
| `cloudinaryContext` | TEXT | raw JSON blob |
| `vault` | INTEGER | 0/1 |

### Indexes

| Name | Columns |
|---|---|
| `idx_videos_provider_createdAt` | `(provider, createdAt DESC)` |
| `idx_videos_createdAt` | `(createdAt DESC)` |
| **NEW** `idx_videos_vault_created` | `(vault, createdAt DESC)` |

## `failures` — permanent-failure audit log

Rows survive after the parent `jobs` row is cleaned up. `videoId` is a soft
reference, not a FK.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `videoId` | TEXT | soft ref |
| `originalProvider` `workerRole` | | which lane it belonged to |
| `prompt` `model` `aspectRatio` `resolution` `duration` `steps` `imageUrl` | | preserved config |
| `error` | TEXT NOT NULL | reason |
| `attemptCount` | INTEGER | how many retries |
| `workerId` | TEXT | who ran it |
| `failedAt` | TEXT NOT NULL | ISO |
| `createdAt` | TEXT | original job createdAt |
| `durationMs` | INTEGER | wall time before failure |
| `vault` | INTEGER | 0/1 |

### Indexes

| Name | Columns |
|---|---|
| `idx_failures_failedAt` | `(failedAt DESC)` |
| `idx_failures_provider` | `(originalProvider, failedAt DESC)` |
| `idx_failures_videoId` | `(videoId)` |

## `combined_videos` — ffmpeg concat outputs

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `sources` | TEXT NOT NULL | JSON array `[{videoId?, url?, uploadId?, combineId?, title?}]` |
| `title` | TEXT | user or auto |
| `status` | TEXT | `queued` \| `processing` \| `completed` \| `failed` |
| `progress` | INTEGER | 0..100 |
| `strategy` | TEXT | `copy` (fast) \| `reencode` (compat) |
| `outputPath` | TEXT | on-disk mp4 |
| `fileSize` | INTEGER | bytes |
| `error` | TEXT | |
| `createdAt` `completedAt` | TEXT | |
| `vault` | INTEGER | 0/1 |

### Indexes

| Name | Columns |
|---|---|
| `idx_combined_videos_status_created` | `(status, createdAt DESC)` |
| **NEW** `idx_combined_videos_vault_created` | `(vault, createdAt DESC)` |

## `yt_jobs` — yt-dlp downloads

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `url` | TEXT NOT NULL | source YouTube URL |
| `format` | TEXT | `mp3` \| `mp4` |
| `quality` | TEXT | `128/192/320` audio or `360/720/1080/best` video |
| `status` | TEXT | `queued`/`processing`/`completed`/`failed` |
| `progress` | INTEGER | 0..100 |
| `title` `duration` `fileSize` `fileName` `filePath` `thumbnail` | | metadata |
| `error` | TEXT | |
| `pid` | INTEGER | yt-dlp process id (kill via /cancel) |
| `worker` | TEXT | `cobalt` (default) \| `home` (5090) |
| `createdAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns |
|---|---|
| `idx_yt_jobs_status_created` | `(status, createdAt DESC)` |
