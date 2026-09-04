# Schema — Image Enhancer

Source: `services/aiVideo/db.js`.

Single table for every state (`queued`/`processing`/`completed`/`failed`) —
the Library / Queue / Failures views are filtered SELECTs off this table.

## `enhanced_images`

| Column | Type | Purpose |
|---|---|---|
| `imageId` | TEXT PK | uuid |
| `status` | TEXT NOT NULL | `queued`/`processing`/`completed`/`failed` |
| `type` | TEXT NOT NULL | `fast` \| `quality` \| `cinematic` \| `edit` |
| `engine` | TEXT NOT NULL | `cloud` (Gemini) \| `local` (5090) |
| `presetId` | TEXT | e.g. `polish` |
| `prompt` | TEXT NOT NULL | |
| `sourceUrl` | TEXT | Cloudinary input |
| `outputUrl` | TEXT | Cloudinary output |
| `error` | TEXT | |
| `bytes` | INTEGER | output size |
| `workerId` | TEXT | |
| `vault` | INTEGER | 0/1 |
| `workflow` | TEXT | Atelier workflow id (e.g. `flux-kontext`) |
| `steps` `denoise` `cfg` `width` `height` | | ComfyUI knobs |
| `logs` | TEXT | JSON |
| `customModel` | TEXT | checkpoint override |
| `negativePrompt` | TEXT | |
| `createdAt` `startedAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_enh_status_created` | `(status, createdAt DESC)` | Queue tab |
| `idx_enh_type_created` | `(type, createdAt DESC)` | type filter |
| `idx_enh_engine_created` | `(engine, createdAt DESC)` | engine filter |
| `idx_enh_completed_created` | `(status, createdAt DESC) WHERE status='completed'` | **partial index** — Library tab |
| **NEW** `idx_enh_vault_completed_created` | `(vault, status, createdAt DESC)` | anon library `WHERE vault=0 AND status='completed'` |
| **NEW** `idx_enh_workflow_created` | `(workflow, createdAt DESC)` | Atelier per-workflow view |
