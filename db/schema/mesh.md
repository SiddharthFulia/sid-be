# Schema — Mesh (text → 3D)

Source: `services/aiVideo/db.js`.

Every generation request is one row. Worker (5090) runs the pipeline and posts
back either `glbUrl` (Cloudinary — legacy) or `glbBlob` (SQLite BLOB — current
default, avoids Cloudinary's 25 GB free-tier cap).

## `mesh_jobs`

| Column | Type | Purpose |
|---|---|---|
| `jobId` | TEXT PK | uuid |
| `status` | TEXT NOT NULL | `queued`/`processing`/`completed`/`failed` |
| `prompt` | TEXT NOT NULL | |
| `model` | TEXT NOT NULL | `shap-e` \| `triposr` \| `trellis` \| `trellis-v2` \| `hunyuan3d` |
| `steps` | INTEGER | diffusion steps |
| `glbUrl` | TEXT | Cloudinary URL (legacy) |
| `publicId` | TEXT | Cloudinary public_id |
| `glbBlob` | BLOB | **current** GLB storage — served via `/api/mesh/file/:jobId` |
| `bytes` `elapsedMs` | INTEGER | |
| `error` `workerId` `progressMessage` | TEXT | |
| `logs` | TEXT | JSON |
| `imageUrl` | TEXT | image-to-3D reference (Cloudinary) |
| `seed` | INTEGER | reproducibility |
| `guidance` | REAL | CFG scale (TRELLIS `ss_guidance` / Hunyuan3D DiT guidance) |
| `negativePrompt` | TEXT | Hunyuan3D only |
| `meshQuality` | INTEGER | 0..100 → TRELLIS `ss_steps` / Hunyuan3D `octree_resolution` |
| `textureQuality` | INTEGER | 0..100 → TRELLIS `slat_steps` / Hunyuan3D `texture_steps` |
| `textureResolution` | INTEGER | 512 / 1024 / 2048 |
| `polygonTarget` | INTEGER | TRELLIS `mesh_simplify` / Hunyuan3D `target_face_num` |
| `createdAt` `startedAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_mesh_status_created` | `(status, createdAt DESC)` | Library + queue |
| **NEW** `idx_mesh_model_status_created` | `(model, status, createdAt DESC)` | per-engine Library filter |
