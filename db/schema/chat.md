# Schema — Chat lane

Source: `services/aiVideo/db.js`.

Multi-turn AI Chat surface. Three tables: threads, messages, inference jobs.
CASCADE from `chat_conversations` → `chat_messages` wipes threads cleanly.

## `chat_conversations`

| Column | Type | Purpose |
|---|---|---|
| `chatId` | TEXT PK | uuid |
| `title` | TEXT | auto from first user line |
| `model` | TEXT | default model for new turns |
| `provider` | TEXT | `cloud-groq` \| `cloud-gemini` \| `oracle-ollama` \| `5090` |
| `pinned` | INTEGER | 0/1 — pinned-first sidebar sort |
| `archived` | INTEGER | 0/1 |
| `vault` | INTEGER | 0/1 |
| `temperature` | REAL | per-thread sampler override |
| `maxTokens` | INTEGER | per-thread cap |
| `imageGenEnabled` | INTEGER | 0/1 — draw-mode toggle |
| `imageGenModel` | TEXT | e.g. `flux-schnell` |
| `createdAt` `updatedAt` | TEXT | ISO |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_chat_conv_updated` | `(archived, updatedAt DESC)` | sidebar list |
| **NEW** `idx_chat_conv_pinned_updated` | `(pinned DESC, archived, updatedAt DESC)` | pinned-first sidebar sort |

## `chat_messages`

Every user + assistant turn. FK CASCADE from `chat_conversations`.

| Column | Type | Purpose |
|---|---|---|
| `messageId` | TEXT PK | uuid |
| `chatId` | TEXT NOT NULL FK | parent thread |
| `role` | TEXT | `user` \| `assistant` \| `system` |
| `content` | TEXT NOT NULL | body |
| `imageUrl` | TEXT | Cloudinary vision input |
| `docName` `docText` | TEXT | attached document |
| `model` `provider` | TEXT | resolved at send time |
| `tokensIn` `tokensOut` `elapsedMs` | INTEGER | telemetry |
| `jobId` | TEXT | linked `chat_jobs.jobId` |
| `compacted` | INTEGER | 0/1 — hidden from context after summarization |
| `createdAt` | TEXT | ISO |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_chat_msgs_chat` | `(chatId, createdAt ASC)` | thread render (ascending on purpose) |
| **NEW** `idx_chat_msgs_job` | `(jobId)` | worker callback → append reply |

## `chat_jobs`

Async Ollama inference queue for 5090. Cloud providers write directly to
`chat_messages` and skip this table.

| Column | Type | Purpose |
|---|---|---|
| `jobId` | TEXT PK | uuid |
| `status` | TEXT | `queued`/`processing`/`completed`/`failed` |
| `model` | TEXT NOT NULL | Ollama model id |
| `messages` | TEXT NOT NULL | JSON `[{role,content}]` |
| `imageUrl` | TEXT | vision |
| `reply` | TEXT | assistant output |
| `elapsedMs` `tokensIn` `tokensOut` | INTEGER | |
| `error` `workerId` `logs` | TEXT | |
| `chatId` `messageId` | TEXT | back-refs to conversation + message |
| `provider` | TEXT | forwarded to router |
| `temperature` | REAL | per-message override |
| `maxTokens` | INTEGER | |
| `createdAt` `startedAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns |
|---|---|
| `idx_chat_status_created` | `(status, createdAt DESC)` |
| **NEW** `idx_chat_jobs_chat` | `(chatId, createdAt DESC)` |
