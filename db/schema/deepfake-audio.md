# Schema — Deepfake / Lip Sync / Audio

Source: `services/aiVideo/db.js`.

Three lanes that share the "one row per job, worker fills output" pattern.
Deepfake is Vault-gated (`requireVault` middleware); the other two are public.

## `deepfake_jobs` (Vault-only)

Face-swap + arbitrary voice cloning. Locked behind the `sid-vault-token` JWT.

| Column | Type | Purpose |
|---|---|---|
| `jobId` | TEXT PK | uuid |
| `status` | TEXT | `queued`/`processing`/`completed`/`failed` |
| `kind` | TEXT NOT NULL | `face-swap` \| `voice-any` |
| `model` | TEXT | `inswapper_128` \| `xtts-v2` \| `xtts-v2+rvc` |
| `sourceUrl` | TEXT | source face image or ref voice clip |
| `targetUrl` | TEXT | target image/video (face-swap) |
| `melodyUrl` | TEXT | melody track (voice-any singing) |
| `prompt` | TEXT | lyrics / text |
| `language` | TEXT | XTTS lang code |
| `outputUrl` `publicId` `bytes` `elapsedMs` | | Cloudinary result + stats |
| `error` `workerId` `progressMessage` | | |
| `analysis` | TEXT | JSON — voice-clone quality metrics |
| `createdAt` `startedAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns |
|---|---|
| `idx_deepfake_status_created` | `(status, createdAt DESC)` |
| `idx_deepfake_kind_created` | `(kind, createdAt DESC)` |

## `lipsync_jobs`

Portrait + audio → talking head video.

| Column | Type | Purpose |
|---|---|---|
| `jobId` | TEXT PK | uuid |
| `status` | TEXT | `queued`/`processing`/`completed`/`failed` |
| `audioUrl` `portraitUrl` `outputUrl` | | Cloudinary URLs |
| `prompt` | TEXT | reserved (LatentSync ignores) |
| `model` | TEXT | `latentsync` \| `musetalk` |
| `error` `bytes` `workerId` | | |
| `durationMs` | INTEGER | source audio ms |
| `logs` | TEXT | JSON |
| `vault` | INTEGER | 0/1 |
| `createdAt` `startedAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_lipsync_status_created` | `(status, createdAt DESC)` | Library |
| `idx_lipsync_vault` | `(vault, status)` | anon filter |

## `audio_jobs`

Music / SFX / TTS / stem-split / STT.

| Column | Type | Purpose |
|---|---|---|
| `jobId` | TEXT PK | uuid |
| `status` | TEXT | `queued`/`processing`/`completed`/`failed` |
| `kind` | TEXT NOT NULL | `music` \| `sfx` \| `tts` \| `stt` \| `separate` \| `voice-clone` \| `voice-sing` |
| `model` | TEXT NOT NULL | `musicgen` \| `stable-audio` \| `bark` \| `whisper-large-v3` \| `demucs` \| `xtts-v2` |
| `prompt` | TEXT NOT NULL | |
| `duration` | INTEGER | seconds (1..47 stable-audio; up to 30 musicgen) |
| `voice` | TEXT | Bark voice preset |
| `outputUrl` `bytes` | | Cloudinary result |
| `sourceUrl` | TEXT | STT source audio |
| `transcript` | TEXT | STT output |
| `stems` | TEXT | JSON `{vocals,drums,bass,other,lyrics}` — Demucs |
| `analysis` | TEXT | JSON — voice-clone metrics |
| `error` `workerId` `logs` | | |
| `vault` | INTEGER | 0/1 |
| `createdAt` `startedAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns |
|---|---|
| `idx_audio_status_created` | `(status, createdAt DESC)` |
| `idx_audio_kind_created` | `(kind, createdAt DESC)` |
| **NEW** `idx_audio_vault_status` | `(vault, status, createdAt DESC)` |
