// SQLite store for the AI Video pipeline. Replaces data/inflight-jobs.json
// (drop-in: same exports as the old storage.js) and adds a videos table for
// completed Cloudinary records so the Library can list/filter without paying
// the Cloudinary Search-API tax.
//
// Why SQLite (and not Postgres):
//  • single file on disk → trivial backup, no service to babysit
//  • better-sqlite3 is sync + ~50k inserts/sec — way past our load
//  • migrating to Postgres later is a Drizzle/Prisma swap; the schema is
//    portable, no code outside this file touches SQL
//
// Why not stay on JSON:
//  • full file rewrite on every status update → race-prone under concurrency
//  • no indexes → list filtering is O(n) over the whole file
//  • impossible to query by provider / date range / log content efficiently

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import logger from '../../helpers/logger.js';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'sid.db');
const LEGACY_JSON = path.join(DATA_DIR, 'inflight-jobs.json');

// ── Connection ──────────────────────────────────────────────────
// WAL mode so reads don't block writes (FE polls /status while worker
// writes /job-progress every second).
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');     // WAL + NORMAL is the recommended fast+safe combo
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────
// Use TEXT for ISO timestamps (sortable lexicographically + portable to PG).
// Use TEXT for JSON columns (logs, cloudinary_context) — SQLite has no native
// JSON type but it parses fine via JSON.parse on the way out.
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    videoId            TEXT PRIMARY KEY,
    provider           TEXT NOT NULL,         -- worker role: 'worker' | 'local'
    originalProvider   TEXT,                  -- FE label: 'optimized' | 'local' | 'worker' | 'zsky'
    status             TEXT NOT NULL,         -- queued | processing | completed | failed
    prompt             TEXT,
    model              TEXT,
    duration           INTEGER,
    resolution         TEXT,
    aspectRatio        TEXT,
    steps              INTEGER,
    style              TEXT,
    audio              INTEGER,                -- 0/1
    imageUrl           TEXT,
    generateCaption    INTEGER,                -- 0/1
    attemptCount       INTEGER NOT NULL DEFAULT 0,
    createdAt          TEXT NOT NULL,
    startedAt          TEXT,
    completedAt        TEXT,
    videoUrl           TEXT,
    caption            TEXT,
    error              TEXT,
    workerId           TEXT,
    estimatedSeconds   INTEGER,
    progressMessage    TEXT,
    progressStep       INTEGER,
    progressTotal      INTEGER,
    logs               TEXT,                    -- JSON array of {ts, msg}
    withMusic          INTEGER NOT NULL DEFAULT 0,
    musicPrompt        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status_provider ON jobs(status, provider);
  CREATE INDEX IF NOT EXISTS idx_jobs_createdAt       ON jobs(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_origProvider    ON jobs(originalProvider);

  CREATE TABLE IF NOT EXISTS videos (
    videoId            TEXT PRIMARY KEY,
    publicId           TEXT,
    videoUrl           TEXT NOT NULL,
    prompt             TEXT,
    provider           TEXT,                    -- FE label (optimized/local/worker/zsky)
    model              TEXT,
    duration           INTEGER,
    aspectRatio        TEXT,
    resolution         TEXT,
    style              TEXT,
    audio              INTEGER,
    caption            TEXT,
    bytes              INTEGER,
    createdAt          TEXT NOT NULL,
    cloudinaryContext  TEXT                     -- raw JSON blob, forward-compat
  );
  CREATE INDEX IF NOT EXISTS idx_videos_provider_createdAt ON videos(provider, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_videos_createdAt          ON videos(createdAt DESC);

  -- Failures: separate audit log of permanently-failed jobs (ones the worker
  -- NACKed without requeue, or that exceeded max-attempts). Decoupled from
  -- the jobs table so:
  --   • the FE can show a 'Failures' tab without filtering across all jobs
  --   • we keep history even after the corresponding job row is cleaned up
  --   • each failure can be linked to the message that landed in the DLQ
  CREATE TABLE IF NOT EXISTS failures (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    videoId            TEXT NOT NULL,
    originalProvider   TEXT,                     -- 'optimized' | 'local' | 'worker' | 'zsky'
    workerRole         TEXT,                     -- 'worker' | 'local'
    prompt             TEXT,
    model              TEXT,
    aspectRatio        TEXT,
    resolution         TEXT,
    duration           INTEGER,
    steps              INTEGER,
    imageUrl           TEXT,
    error              TEXT NOT NULL,
    attemptCount       INTEGER NOT NULL DEFAULT 1,
    workerId           TEXT,
    failedAt           TEXT NOT NULL,
    createdAt          TEXT,
    durationMs         INTEGER                   -- total wall time before failure
  );
  CREATE INDEX IF NOT EXISTS idx_failures_failedAt      ON failures(failedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_failures_provider      ON failures(originalProvider, failedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_failures_videoId       ON failures(videoId);

  -- Extra hot-path indexes on jobs for the queue + library + retry views.
  CREATE INDEX IF NOT EXISTS idx_jobs_origProv_created  ON jobs(originalProvider, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status_created    ON jobs(status, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_model             ON jobs(model);

  -- Image Enhancer pipeline. One table for all states (queued/processing/
  -- completed/failed) — Library / Queue / Failures views are filtered queries.
  --   type: fast | quality | cinematic | edit
  --   engine: cloud (Gemini) | local (5090)
  CREATE TABLE IF NOT EXISTS enhanced_images (
    imageId        TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    type           TEXT NOT NULL,
    engine         TEXT NOT NULL,
    presetId       TEXT,
    prompt         TEXT NOT NULL,
    sourceUrl      TEXT,
    outputUrl      TEXT,
    error          TEXT,
    bytes          INTEGER,
    workerId       TEXT,
    createdAt      TEXT NOT NULL,
    startedAt      TEXT,
    completedAt    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_enh_status_created  ON enhanced_images(status, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_enh_type_created    ON enhanced_images(type, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_enh_engine_created  ON enhanced_images(engine, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_enh_completed_created ON enhanced_images(status, createdAt DESC) WHERE status = 'completed';
`);

// ── One-time migration from the legacy JSON file ────────────────
// If the old inflight-jobs.json exists and the jobs table is empty, import
// each entry. After import, rename the JSON to *.imported so a subsequent
// boot doesn't double-insert. Safe to run repeatedly.
function migrateLegacyJson() {
  try {
    if (!fs.existsSync(LEGACY_JSON)) return;
    const count = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    if (count > 0) {
      // We've already migrated — archive the JSON so we don't keep eyeing it.
      try {
        const archived = `${LEGACY_JSON}.imported`;
        if (!fs.existsSync(archived)) fs.renameSync(LEGACY_JSON, archived);
      } catch {}
      return;
    }
    const raw = fs.readFileSync(LEGACY_JSON, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || items.length === 0) {
      try { fs.renameSync(LEGACY_JSON, `${LEGACY_JSON}.imported`); } catch {}
      return;
    }
    const stmt = db.prepare(`INSERT OR IGNORE INTO jobs (
      videoId, provider, originalProvider, status, prompt, model, duration,
      resolution, aspectRatio, steps, style, audio, imageUrl, generateCaption,
      attemptCount, createdAt, startedAt, completedAt, videoUrl, caption, error,
      workerId, estimatedSeconds, progressMessage, progressStep, progressTotal, logs
    ) VALUES (
      @videoId, @provider, @originalProvider, @status, @prompt, @model, @duration,
      @resolution, @aspectRatio, @steps, @style, @audio, @imageUrl, @generateCaption,
      @attemptCount, @createdAt, @startedAt, @completedAt, @videoUrl, @caption, @error,
      @workerId, @estimatedSeconds, @progressMessage, @progressStep, @progressTotal, @logs
    )`);
    const insertMany = db.transaction((rows) => {
      for (const j of rows) stmt.run(jobToRow(j));
    });
    insertMany(items);
    fs.renameSync(LEGACY_JSON, `${LEGACY_JSON}.imported`);
    logger.info(`SQLite: migrated ${items.length} jobs from inflight-jobs.json`);
  } catch (err) {
    logger.error('SQLite legacy migration failed', err.message);
  }
}

// ── Row ↔ object helpers ────────────────────────────────────────
// SQLite stores booleans/JSON as integers/strings; convert at the boundary
// so the rest of the codebase doesn't see SQL-flavoured types.
export function jobToRow(j) {
  return {
    videoId: j.videoId,
    provider: j.provider || 'worker',
    originalProvider: j.originalProvider || j.provider || null,
    status: j.status || 'queued',
    prompt: j.prompt ?? null,
    model: j.model ?? null,
    duration: j.duration ?? null,
    resolution: j.resolution ?? null,
    aspectRatio: j.aspectRatio ?? null,
    steps: j.steps ?? null,
    style: j.style ?? null,
    audio: j.audio == null ? null : (j.audio ? 1 : 0),
    imageUrl: j.imageUrl ?? null,
    generateCaption: j.generateCaption == null ? null : (j.generateCaption ? 1 : 0),
    attemptCount: j.attemptCount ?? 0,
    createdAt: j.createdAt || new Date().toISOString(),
    startedAt: j.startedAt ?? null,
    completedAt: j.completedAt ?? null,
    videoUrl: j.videoUrl ?? null,
    caption: j.caption ?? null,
    error: j.error ?? null,
    workerId: j.workerId ?? null,
    estimatedSeconds: j.estimatedSeconds ?? null,
    progressMessage: j.progressMessage ?? null,
    progressStep: j.progressStep ?? null,
    progressTotal: j.progressTotal ?? null,
    logs: j.logs ? JSON.stringify(j.logs) : null,
    withMusic: j.withMusic ? 1 : 0,
    musicPrompt: j.musicPrompt ?? null,
  };
}

export function rowToJob(r) {
  if (!r) return null;
  return {
    videoId: r.videoId,
    provider: r.provider,
    originalProvider: r.originalProvider,
    status: r.status,
    prompt: r.prompt,
    model: r.model,
    duration: r.duration,
    resolution: r.resolution,
    aspectRatio: r.aspectRatio,
    steps: r.steps,
    style: r.style,
    audio: r.audio == null ? null : !!r.audio,
    imageUrl: r.imageUrl,
    generateCaption: r.generateCaption == null ? null : !!r.generateCaption,
    attemptCount: r.attemptCount,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    videoUrl: r.videoUrl,
    caption: r.caption,
    error: r.error,
    workerId: r.workerId,
    estimatedSeconds: r.estimatedSeconds,
    progressMessage: r.progressMessage,
    progressStep: r.progressStep,
    progressTotal: r.progressTotal,
    logs: r.logs ? safeJSON(r.logs, []) : [],
    withMusic: !!r.withMusic,
    musicPrompt: r.musicPrompt,
  };
}

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

migrateLegacyJson();

// ── In-place ALTERs for existing databases ───────────────────────────
// SQLite doesn't support `IF NOT EXISTS` on ADD COLUMN, so we probe + try.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info(`SQLite: added column ${table}.${column}`);
}
addColumnIfMissing('jobs', 'withMusic',   'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('jobs', 'musicPrompt', 'TEXT');
// vault=1 means this job was created via vault auth → listings hide it from
// anonymous visitors. Propagated from jobs → videos / failures on completion.
addColumnIfMissing('jobs',            'vault', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('videos',          'vault', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('failures',        'vault', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('enhanced_images', 'vault', 'INTEGER NOT NULL DEFAULT 0');
// Atelier workflow + fine-tunes + log feed for the image-enhance lane
addColumnIfMissing('enhanced_images', 'workflow', 'TEXT');
addColumnIfMissing('enhanced_images', 'steps',    'INTEGER');
addColumnIfMissing('enhanced_images', 'denoise',  'REAL');
addColumnIfMissing('enhanced_images', 'cfg',      'REAL');
addColumnIfMissing('enhanced_images', 'width',    'INTEGER');
addColumnIfMissing('enhanced_images', 'height',   'INTEGER');
addColumnIfMissing('enhanced_images', 'logs',     'TEXT');   // JSON array
addColumnIfMissing('enhanced_images', 'customModel', 'TEXT'); // checkpoint override
// Optional negative prompt — forwarded to ComfyUI's negative CLIPTextEncode
// for SDXL/Pony/Flux workflows. Helps tame "deformed, watermark, blurry" etc.
addColumnIfMissing('enhanced_images', 'negativePrompt', 'TEXT');

// Speech-to-Text result. `audio_jobs.kind='stt'` rows store the transcribed
// text here instead of in a Cloudinary URL — the "output" of STT is plain
// text. `sourceUrl` carries the Cloudinary URL of the uploaded audio so the
// worker can fetch the file to transcribe.
addColumnIfMissing('audio_jobs', 'transcript', 'TEXT');
addColumnIfMissing('audio_jobs', 'sourceUrl',  'TEXT');

// Source separation result. `audio_jobs.kind='separate'` rows store a
// JSON object in `stems` like:
//   { "vocals": "https://…", "drums": "…", "bass": "…", "other": "…",
//     "lyrics": "I see trees of green …" }
// Worker writes this after running Demucs (4-stem) + Whisper on the vocals.
addColumnIfMissing('audio_jobs', 'stems', 'TEXT');

// ─── Chat conversations + messages (multi-turn 5090 chat) ────
// Each conversation is a thread the user can resume at /ai/<id>. Lives
// across sessions — sidebar lists them all. Schema kept lean:
//   chat_conversations: metadata (title, default model, timestamps)
//   chat_messages:      every user + assistant turn, with optional
//                       image/doc URL + per-message model override
//                       (a chat can switch models mid-thread)
//
// chat_jobs (below) stays as the async inference queue — each user
// message creates a chat_job, worker calls Ollama, BE appends the
// assistant message to chat_messages on completion.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_conversations (
    chatId      TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT 'New chat',
    model       TEXT,                 -- default model for new messages
    provider    TEXT,                 -- 'cloud-groq' | 'cloud-gemini' | 'oracle-ollama' | '5090'
    pinned      INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    vault       INTEGER NOT NULL DEFAULT 0,
    createdAt   TEXT NOT NULL,
    updatedAt   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_conv_updated  ON chat_conversations(archived, updatedAt DESC);

  CREATE TABLE IF NOT EXISTS chat_messages (
    messageId   TEXT PRIMARY KEY,
    chatId      TEXT NOT NULL REFERENCES chat_conversations(chatId) ON DELETE CASCADE,
    role        TEXT NOT NULL,        -- 'user' | 'assistant' | 'system'
    content     TEXT NOT NULL,
    imageUrl    TEXT,                 -- Cloudinary URL (vision input or retained from past)
    docName     TEXT,                 -- attached document filename (for display)
    docText     TEXT,                 -- extracted text content embedded as context
    model       TEXT,                 -- model used for THIS message (assistant only)
    provider    TEXT,
    tokensIn    INTEGER,
    tokensOut   INTEGER,
    elapsedMs   INTEGER,
    jobId       TEXT,                 -- chat_jobs row that produced this assistant message
    createdAt   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_msgs_chat ON chat_messages(chatId, createdAt ASC);
`);

// ─── Chat jobs (Ollama inference queue) ──────────────────────
// CREATE must come BEFORE addColumnIfMissing — on a fresh BE the
// ALTER calls used to run first and fail with "no such table".
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_jobs (
    jobId       TEXT PRIMARY KEY,
    status      TEXT NOT NULL,           -- queued | processing | completed | failed
    model       TEXT NOT NULL,           -- ollama model id (e.g. qwen2.5:32b-instruct-q4_K_M)
    messages    TEXT NOT NULL,           -- JSON array of {role, content}
    imageUrl    TEXT,                    -- Cloudinary URL for vision models
    reply       TEXT,                    -- assistant text (set on completion)
    elapsedMs   INTEGER,                 -- inference time on the 5090
    tokensIn    INTEGER,
    tokensOut   INTEGER,
    error       TEXT,
    workerId    TEXT,
    logs        TEXT,
    createdAt   TEXT NOT NULL,
    startedAt   TEXT,
    completedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_status_created ON chat_jobs(status, createdAt DESC);
`);

// `chatId` links the job back to its conversation so the BE knows where
// to append the assistant reply on completion. Lazy-added so existing
// rows from before the conversations feature shipped don't get nuked.
addColumnIfMissing('chat_jobs', 'chatId',      'TEXT');
addColumnIfMissing('chat_jobs', 'messageId',   'TEXT');
addColumnIfMissing('chat_jobs', 'provider',    'TEXT');
// Optional inference overrides forwarded to the worker. NULL = the
// worker uses Ollama's per-model defaults.
addColumnIfMissing('chat_jobs', 'temperature', 'REAL');
addColumnIfMissing('chat_jobs', 'maxTokens',   'INTEGER');

// `compacted = 1` marks a message as part of a compacted slice — it stays
// in the table for auditing but is excluded from listMessages() and from
// the history sent to the model. The compaction handler inserts a new
// role='system' message holding the summary in its place.
addColumnIfMissing('chat_messages', 'compacted', 'INTEGER NOT NULL DEFAULT 0');
// Per-conversation generation overrides. NULL = model default (BE doesn't
// forward the param). Set by the user from the "⚙ Advanced" popover.
addColumnIfMissing('chat_conversations', 'temperature', 'REAL');
addColumnIfMissing('chat_conversations', 'maxTokens',   'INTEGER');
// Image-gen opt-in: off by default so visitors don't burn Cloudflare quota
// on accidental "draw" matches. When enabled, imageGenModel selects which
// Cloudflare AI slug runs (Flux Schnell by default).
addColumnIfMissing('chat_conversations', 'imageGenEnabled', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('chat_conversations', 'imageGenModel',   'TEXT');

// ─── Lip Sync lane (Tier 3, added 2026-05) ────────────────
// LatentSync workflow: audio + portrait → talking head video.
db.exec(`
  CREATE TABLE IF NOT EXISTS lipsync_jobs (
    jobId          TEXT PRIMARY KEY,
    status         TEXT NOT NULL,        -- queued | processing | completed | failed
    audioUrl       TEXT,                 -- Cloudinary URL of source audio
    portraitUrl    TEXT,                 -- Cloudinary URL of source portrait
    outputUrl      TEXT,                 -- Cloudinary URL of resulting talking-head video
    prompt         TEXT,                 -- optional (LatentSync ignores it; reserved for future models)
    model          TEXT,                 -- latentsync | musetalk (future)
    error          TEXT,
    bytes          INTEGER,
    workerId       TEXT,
    durationMs     INTEGER,              -- length of the source audio in ms
    logs           TEXT,                 -- JSON array {ts, msg}
    vault          INTEGER NOT NULL DEFAULT 0,
    createdAt      TEXT NOT NULL,
    startedAt      TEXT,
    completedAt    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lipsync_status_created ON lipsync_jobs(status, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_lipsync_vault           ON lipsync_jobs(vault, status);
`);

// ─── Audio Studio lane (Tier 3) ────────────────────────────
// Stable Audio Open (SFX/ambience) and Bark (TTS) outputs. Distinct from the
// existing /api/music/generate which is MusicGen-specific. Same SQLite store
// pattern as the image lane.
db.exec(`
  CREATE TABLE IF NOT EXISTS audio_jobs (
    jobId          TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    kind           TEXT NOT NULL,        -- music | sfx | tts
    model          TEXT NOT NULL,        -- musicgen | stable-audio | bark
    prompt         TEXT NOT NULL,
    duration       INTEGER,              -- seconds (1-47 for stable-audio; up to 30 for musicgen)
    voice          TEXT,                 -- bark voice preset id (TTS only)
    outputUrl      TEXT,
    bytes          INTEGER,
    error          TEXT,
    workerId       TEXT,
    logs           TEXT,
    vault          INTEGER NOT NULL DEFAULT 0,
    createdAt      TEXT NOT NULL,
    startedAt      TEXT,
    completedAt    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audio_status_created ON audio_jobs(status, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_audio_kind_created    ON audio_jobs(kind, createdAt DESC);
`);

// ─── Unified log feed (added 2026-05) ─────────────────────────
// Lives in its own table so the main job tables stay lean — without this,
// each row in jobs/enhanced_images/lipsync_jobs/audio_jobs would carry up
// to ~25 KB of log JSON in the `logs` column, bloating reads + backups.
//
// Single table for ALL four lanes — distinguished by `lane`. Indexed on
// (jobId, lane, ts DESC) so the per-job tail query (the only one the FE
// makes) is instant. Append-only — no UPDATE path.
db.exec(`
  CREATE TABLE IF NOT EXISTS job_logs (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    jobId  TEXT NOT NULL,
    lane   TEXT NOT NULL,          -- 'video' | 'image' | 'lipsync' | 'audio'
    ts     INTEGER NOT NULL,       -- ms epoch
    msg    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(jobId, lane, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_job_logs_ts  ON job_logs(ts DESC);
`);

// ─── Cinema mode (Tier 3) ───────────────────────────────────
// Orchestration on top of the video lane: a master prompt → Groq splits into
// N shot prompts → render each via the standard video pipeline → ffmpeg stitch.
// This table tracks the master + child relationship.
db.exec(`
  CREATE TABLE IF NOT EXISTS cinema_projects (
    projectId      TEXT PRIMARY KEY,
    status         TEXT NOT NULL,        -- planning | rendering | stitching | completed | failed
    masterPrompt   TEXT NOT NULL,
    shotCount      INTEGER NOT NULL,
    shotPrompts    TEXT,                 -- JSON array of strings (Groq output)
    shotJobIds     TEXT,                 -- JSON array of videoId (the rendered children)
    outputUrl      TEXT,                 -- final stitched mp4 on Cloudinary
    error          TEXT,
    durationPerShot INTEGER,             -- seconds
    aspectRatio    TEXT,
    resolution     TEXT,
    vault          INTEGER NOT NULL DEFAULT 0,
    createdAt      TEXT NOT NULL,
    completedAt    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cinema_status_created ON cinema_projects(status, createdAt DESC);
`);

logger.info(`SQLite: ${DB_PATH} ready`);
