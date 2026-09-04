# Schema — Cinema (multi-shot orchestration)

Source: `services/aiVideo/db.js`.

Cinema splits a master prompt into N shots via Groq, then chains each shot
through the standard video pipeline with last-frame continuity. Three tables:
projects (planning + config), renders (per-attempt state), job_logs (unified
timeline).

## `cinema_projects`

Master project — one per Groq-planned master prompt.

| Column | Type | Purpose |
|---|---|---|
| `projectId` | TEXT PK | uuid |
| `status` | TEXT NOT NULL | `planning` \| `rendering` \| `stitching` \| `completed` \| `failed` |
| `masterPrompt` | TEXT NOT NULL | |
| `shotCount` | INTEGER NOT NULL | Groq output length |
| `shotPrompts` | TEXT | JSON array of shot-action strings |
| `shotJobIds` | TEXT | JSON array of `videoId` per shot |
| `outputUrl` | TEXT | final stitched mp4 |
| `error` | TEXT | |
| `durationPerShot` | INTEGER | seconds |
| `aspectRatio` `resolution` | TEXT | |
| `vault` | INTEGER | 0/1 |
| `shotModels` | TEXT | JSON `[modelId,...]` — per-shot Beast model override |
| `shotMusic` | TEXT | JSON `[0/1,...]` — per-shot MusicGen toggle |
| `continuityBible` | TEXT | JSON `{subject,wardrobe,environment,lighting,camera,palette}` |
| `lockedSeed` | INTEGER | sampler seed reused across shots |
| `motionStrength` | REAL | 0.1..1.0 |
| `heroImageUrl` | TEXT | shot-1 imageUrl (I2V chain start) |
| `stepsPerShot` | INTEGER | render step-count override |
| `shotNegatives` | TEXT | JSON `[negativePrompt,...]` — Groq per-shot |
| `directorState` | TEXT | JSON `{physicalState,cameraState,emotionArc,negativeContinuityRules}` |
| `continuityMode` `overlapMode` `realismMode` | INTEGER | 0/1 director toggles |
| `createdAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns |
|---|---|
| `idx_cinema_status_created` | `(status, createdAt DESC)` |
| **NEW** `idx_cinema_projects_vault_created` | `(vault, createdAt DESC)` |

## `cinema_renders` — per-attempt resumable state

One row per render attempt. Multiple attempts per project supported so the
user can re-render with tweaks without losing prior output.

| Column | Type | Purpose |
|---|---|---|
| `renderId` | TEXT PK | uuid |
| `projectId` | TEXT NOT NULL | ref to `cinema_projects.projectId` |
| `status` | TEXT NOT NULL | `queued` \| `rendering` \| `extracting` \| `uploading` \| `combining` \| `completed` \| `failed` \| `cancelled` |
| `phase` | TEXT | mirrors FE PHASES for the status pill |
| `currentShotIndex` | INTEGER | 0..shotCount-1 |
| `shotCount` | INTEGER NOT NULL | |
| `shotJobIds` | TEXT | JSON array indexed by shot |
| `combineJobId` | INTEGER | ref to `combined_videos.id` |
| `finalDownloadHref` | TEXT | `/api/combine/file/<id>` |
| `error` | TEXT | |
| `vault` | INTEGER | 0/1 |
| `provider` | TEXT | `local` \| `zsky` |
| `optimizedMode` | TEXT | `preview` \| `balanced` \| `quality` |
| `beastModel` | TEXT | model id when provider=`local` |
| `createdAt` `updatedAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_cinema_renders_project` | `(projectId, createdAt DESC)` | attempt history for a project |
| `idx_cinema_renders_status` | `(status, createdAt DESC)` | active renders panel |

## `job_logs` — unified log timeline

Append-only. Separated from parent rows so `jobs`/`enhanced_images`/etc. stay
lean (a Cinema shot can produce ~25 KB of log JSON otherwise).

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `jobId` | TEXT NOT NULL | soft ref to the parent job |
| `lane` | TEXT NOT NULL | `video` \| `image` \| `lipsync` \| `audio` \| `mesh` \| `room` |
| `ts` | INTEGER NOT NULL | ms since epoch |
| `msg` | TEXT NOT NULL | log line |
| `cinemaRenderId` | TEXT | when set, groups shot logs under a Cinema render |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_job_logs_job` | `(jobId, lane, ts DESC)` | per-job tail |
| `idx_job_logs_ts` | `(ts DESC)` | global tail (admin) |
| **NEW** `idx_job_logs_render` | `(cinemaRenderId, ts ASC)` | `/api/cinema/render/:renderId/logs` (chronological across all shots) |
