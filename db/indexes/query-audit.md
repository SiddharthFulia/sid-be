# Query audit

Hot queries → which index each hits. Run
`EXPLAIN QUERY PLAN <sql>` to confirm any query below still hits the listed
index after a refactor.

## AI Video lane

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Worker `next-job` | `status='queued' AND provider=?` | `createdAt ASC` | `idx_jobs_status_provider` |
| Library per-provider | `originalProvider=?` | `createdAt DESC` | `idx_jobs_origProv_created` |
| Anon Library | `vault=0` | `createdAt DESC` | **`idx_jobs_vault_created`** (new) |
| Failures tab | `status='failed'` | `createdAt DESC` | `idx_jobs_status_created` |
| Combined-videos anon | `vault=0` | `createdAt DESC` | **`idx_combined_videos_vault_created`** (new) |

## Images

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Library completed | `status='completed'` | `createdAt DESC` | `idx_enh_completed_created` (partial) |
| Anon Library | `vault=0 AND status='completed'` | `createdAt DESC` | **`idx_enh_vault_completed_created`** (new) |
| Atelier per-workflow | `workflow=?` | `createdAt DESC` | **`idx_enh_workflow_created`** (new) |
| Queue tab | `status IN ('queued','processing')` | `createdAt DESC` | `idx_enh_status_created` |

## Chat

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Sidebar list | `archived=0` | `updatedAt DESC` | `idx_chat_conv_updated` |
| Sidebar with pinned-first | `archived=0` | `pinned DESC, updatedAt DESC` | **`idx_chat_conv_pinned_updated`** (new) |
| Thread render | `chatId=?` | `createdAt ASC` | `idx_chat_msgs_chat` |
| Worker callback → find message by jobId | `jobId=?` | — | **`idx_chat_msgs_job`** (new) |
| Per-thread job history | `chatId=?` | `createdAt DESC` | **`idx_chat_jobs_chat`** (new) |

## Mesh

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Library | `status='completed'` | `createdAt DESC` | `idx_mesh_status_created` |
| Per-engine Library | `model=? AND status='completed'` | `createdAt DESC` | **`idx_mesh_model_status_created`** (new) |

## Audio / Deepfake / Lip Sync

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Anon audio Library | `vault=0 AND status='completed'` | `createdAt DESC` | **`idx_audio_vault_status`** (new) |
| Lip Sync anon | `vault=0 AND status='completed'` | `createdAt DESC` | `idx_lipsync_vault` |

## Room

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Status polling | `jobId=?` | — | PK |
| Admin dashboard | `status IN ('rendering','failed')` | `createdAt DESC` | `idx_room_status_created` |
| Worker debug | `workerId=? AND status=?` | — | **`idx_room_worker_status`** (new) |

## Cinema

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Library | `vault=0` | `createdAt DESC` | **`idx_cinema_projects_vault_created`** (new) |
| Attempts per project | `projectId=?` | `createdAt DESC` | `idx_cinema_renders_project` |
| Timeline logs | `cinemaRenderId=?` | `ts ASC` | **`idx_job_logs_render`** (new) |

## Chess

| Query | WHERE | ORDER BY | Index |
|---|---|---|---|
| Per-collection library | `collection=?` | `updatedAt DESC` | **`idx_chess_games_collection_updated`** (new) |
| Session validation (white) | `whiteSession=?` | — | **`idx_chess_matches_white_session`** (new) |
| Session validation (black) | `blackSession=?` | — | **`idx_chess_matches_black_session`** (new) |
| Attempt history | `user_id=?` | `created_at DESC` | **`idx_attempts_user_created`** (new) |

## How to re-audit

```bash
sqlite3 data/sid.db 'EXPLAIN QUERY PLAN <your query>'
```

Look for `SEARCH TABLE ... USING INDEX <name>` in the output. If you see
`SCAN TABLE`, you're doing a full-table scan — add an index or fix the WHERE.
