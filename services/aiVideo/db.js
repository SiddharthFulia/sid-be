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
    seed: Number.isFinite(j.seed) ? Math.floor(j.seed) : null,
    motionStrength: Number.isFinite(j.motionStrength) ? Number(j.motionStrength) : null,
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
    seed: r.seed,
    motionStrength: r.motionStrength,
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
// Combined-video vault propagation: if any source video used in a combine
// was vault-flagged then the resulting combined row is too — so it shows
// up in the Vault library and stays hidden from anonymous viewers.
addColumnIfMissing('combined_videos', 'vault', 'INTEGER NOT NULL DEFAULT 0');
// Cinema render — which provider + mode the chain should use. Lets the
// planner pick "5090 Optimized · Quality" (Wan 2.2 5B 30 steps),
// "Balanced" (Wan 2.2 5B 14 steps), or "Preview" (LTX-distilled). The
// columns are added lazily here so old cinema_renders rows (created
// before this lane existed) keep working with the legacy default.
addColumnIfMissing('cinema_renders', 'provider',      'TEXT');
addColumnIfMissing('cinema_renders', 'optimizedMode', 'TEXT');
// Per-shot configuration so the Cinema planner can pick a different
// model + music toggle for each shot when running on the Beast lane.
// Both are nullable JSON arrays of length === shotCount. When null the
// chain uses provider-level defaults (existing behaviour).
//   shotModels: array of model ids (e.g. 'wan-2.2', 'ltx-video', …)
//               applied only when provider === 'local'.
//   shotMusic:  array of 0/1 booleans; if 1 the worker generates +
//               muxes a MusicGen track derived from the shot prompt.
addColumnIfMissing('cinema_projects', 'shotModels', 'TEXT');
addColumnIfMissing('cinema_projects', 'shotMusic',  'TEXT');
// Cinematic-continuity columns. All nullable so existing rows keep
// working. cinemaChain.queueNextShot reads each and falls back to a
// sane default when the column is null.
//   continuityBible — JSON {subject,wardrobe,environment,lighting,camera,palette}.
//                     Prepended to every shot's prompt so the model rebuilds
//                     the same world each clip instead of reinventing it.
//   lockedSeed       — integer fed to the diffusion sampler's noise init.
//                     Same seed + same prompt = same look. Random per render
//                     unless the user overrides.
//   motionStrength   — 0.1..1.0. Wan/Hunyuan honour it; LTX ignores. Lower
//                     keeps the subject's identity stable, higher moves
//                     the camera/scene more but risks mutation.
//   heroImageUrl     — Cloudinary URL of the master first frame. When set,
//                     the orchestrator uses this as shot 1's imageUrl so
//                     the chain is I2V→I2V→… instead of T2V→I2V→…
addColumnIfMissing('cinema_projects', 'continuityBible', 'TEXT');
addColumnIfMissing('cinema_projects', 'lockedSeed',      'INTEGER');
addColumnIfMissing('cinema_projects', 'motionStrength',  'REAL');
addColumnIfMissing('cinema_projects', 'heroImageUrl',    'TEXT');
// cinema_renders gets the render-level Beast model so the user can
// keep the same project but A/B "Wan 2.2 5B" vs "Wan 2.1 I2V 14B" vs
// "Hunyuan" between attempts. Only consulted when provider='local'.
addColumnIfMissing('cinema_renders',  'beastModel',      'TEXT');
// Per-job knobs needed by the cinema chain so each shot reproduces the
// same noise init + motion behaviour. Plain video jobs from /generate
// pass them through too — Wan/Hunyuan workflows on the worker side
// read them at workflow-build time.
addColumnIfMissing('jobs', 'seed',           'INTEGER');
addColumnIfMissing('jobs', 'motionStrength', 'REAL');
// job_logs.cinemaRenderId — when a log line belongs to a shot in a
// cinema render, this column carries the parent renderId. Lets the
// new GET /api/cinema/render/:renderId/logs endpoint stream every
// log line across all 4 (or whatever N) shots PLUS the combine step
// in one ordered timeline, so the user can scroll the whole render
// without hopping between per-shot accordions. Nullable so non-cinema
// jobs (regular AI Video, Image, etc.) leave it blank.
addColumnIfMissing('job_logs', 'cinemaRenderId', 'TEXT');
// ─── Mesh job advanced controls (TRELLIS, TRELLIS v2, Hunyuan3D) ────
// `seed`             — reproducibility across all engines
// `guidance`         — classifier-free guidance scale; for TRELLIS this
//                      is `ss_guidance` (typical 7.5), for Hunyuan3D it
//                      is the shape-gen DiT guidance (typical 5.0)
// `negativePrompt`   — soft negative for Hunyuan3D (Shap-E ignores)
// `meshQuality`      — 0..100 slider; the worker maps to engine-specific
//                      knobs: TRELLIS → `ss_steps` (sparse-structure flow
//                      sampling steps), Hunyuan3D → `octree_resolution`
//                      (256 → 384 → 512 across the slider range)
// `textureQuality`   — 0..100 slider; maps to TRELLIS `slat_steps`
//                      (structured-latent flow) or Hunyuan3D
//                      `texture_steps` (texture DiT inference steps)
// `textureResolution`— 512 / 1024 / 2048 — texture map output size
// `polygonTarget`    — target triangle count after decimation
//                      (TRELLIS `mesh_simplify`, Hunyuan3D `target_face_num`)
addColumnIfMissing('mesh_jobs', 'seed',              'INTEGER');
addColumnIfMissing('mesh_jobs', 'guidance',          'REAL');
addColumnIfMissing('mesh_jobs', 'negativePrompt',    'TEXT');
addColumnIfMissing('mesh_jobs', 'meshQuality',       'INTEGER');
addColumnIfMissing('mesh_jobs', 'textureQuality',    'INTEGER');
addColumnIfMissing('mesh_jobs', 'textureResolution', 'INTEGER');
addColumnIfMissing('mesh_jobs', 'polygonTarget',     'INTEGER');
// Reference image for image-conditioned mesh generation. TRELLIS image-
// large (default for `trellis` / `trellis-v2`) and Hunyuan3D-2 both take
// a single RGB image as the structural conditioning signal — the worker
// pulls this URL, decodes locally, and feeds it into the pipeline. Null
// = pure text-to-3D (Shap-E, TripoSR fallback, or TRELLIS-text-large).
addColumnIfMissing('mesh_jobs', 'imageUrl',          'TEXT');
// Generated GLB stored as a BLOB directly inside SQLite. Reference image
// (input) still goes to Cloudinary so the FE preview is a normal <img
// src=…>; the OUTPUT GLB lives here so the asset is owned by the BE and
// not subject to Cloudinary's free-tier 25GB cap. The /api/mesh/file/:jobId
// endpoint streams this column out with model/gltf-binary content-type.
addColumnIfMissing('mesh_jobs', 'glbBlob',           'BLOB');

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

// ─── Mesh jobs (text → 3D mesh on 5090, e.g. Shap-E) ─────────
// One row per generation request. Worker pulls the row, runs the
// text-to-3D pipeline, uploads the resulting GLB to Cloudinary, then
// posts back glbUrl + publicId + bytes. FE polls /api/mesh/status/:jobId.
db.exec(`
  CREATE TABLE IF NOT EXISTS mesh_jobs (
    jobId            TEXT PRIMARY KEY,
    status           TEXT NOT NULL,           -- queued | processing | completed | failed
    prompt           TEXT NOT NULL,
    model            TEXT NOT NULL,           -- 'shap-e' | future options
    steps            INTEGER,                 -- diffusion steps (16-64, default 32)
    glbUrl           TEXT,                    -- Cloudinary URL of the .glb on completion
    publicId         TEXT,                    -- Cloudinary public_id
    bytes            INTEGER,                 -- file size of the .glb
    elapsedMs        INTEGER,
    error            TEXT,
    workerId         TEXT,
    logs             TEXT,                    -- JSON array (legacy; new lines go via job_logs)
    progressMessage  TEXT,
    createdAt        TEXT NOT NULL,
    startedAt        TEXT,
    completedAt      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mesh_status_created ON mesh_jobs(status, createdAt DESC);
`);

// ─── Deepfake jobs (face swap + voice-clone-of-anyone, Vault-gated) ─
// Locked behind requireVault at the route level — only the password-holder
// can submit. Two kinds:
//   • 'face-swap' — source face image + target image → swapped image
//                   (insightface inswapper_128.onnx on the 5090)
//   • 'voice-any' — same shape as the public voice-clone, but skips the
//                   consent attestation (the Vault gate replaces it)
// One row per request; columns are deliberately superset of mesh + voice
// so the worker can dispatch by kind.
db.exec(`
  CREATE TABLE IF NOT EXISTS deepfake_jobs (
    jobId            TEXT PRIMARY KEY,
    status           TEXT NOT NULL,           -- queued | processing | completed | failed
    kind             TEXT NOT NULL,           -- 'face-swap' | 'voice-any'
    model            TEXT,                    -- 'inswapper_128' | 'xtts-v2' | 'xtts-v2+rvc'
    -- Inputs (URLs after Cloudinary upload)
    sourceUrl        TEXT,                    -- source face (face-swap) or ref clip (voice-any)
    targetUrl        TEXT,                    -- target image / video (face-swap)
    melodyUrl        TEXT,                    -- melody track (voice-any singing variant)
    prompt           TEXT,                    -- text/lyrics for voice-any
    language         TEXT,                    -- XTTS language code for voice-any
    -- Output
    outputUrl        TEXT,
    publicId         TEXT,
    bytes            INTEGER,
    elapsedMs        INTEGER,
    -- Bookkeeping
    error            TEXT,
    workerId         TEXT,
    progressMessage  TEXT,
    createdAt        TEXT NOT NULL,
    startedAt        TEXT,
    completedAt      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deepfake_status_created ON deepfake_jobs(status, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_deepfake_kind_created   ON deepfake_jobs(kind, createdAt DESC);
`);

// ─── Runner game (hand-gesture Subway-Surfers-style) ─────────────
// Lightweight player registry — name only, no auth. Lets a returning
// visitor pick their existing name from a list instead of re-typing.
// Scores table is the actual leaderboard storage; UNIQUE(name) on the
// player row makes "pick or create" a single upsert.
db.exec(`
  CREATE TABLE IF NOT EXISTS games_players (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    createdAt     TEXT NOT NULL,
    lastPlayedAt  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_games_players_lastplayed ON games_players(lastPlayedAt DESC);

  CREATE TABLE IF NOT EXISTS games_scores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    playerId      INTEGER NOT NULL,
    playerName    TEXT NOT NULL,                 -- denormalised for fast leaderboard reads
    score         INTEGER NOT NULL,
    distance      INTEGER NOT NULL,              -- meters travelled at game-end
    difficulty    TEXT NOT NULL,                 -- 'easy' | 'medium' | 'hard' | 'classic'
    revived       INTEGER NOT NULL DEFAULT 0,    -- 1 if the run used the one-shot revive
    createdAt     TEXT NOT NULL,
    FOREIGN KEY (playerId) REFERENCES games_players(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_games_scores_score ON games_scores(score DESC);
  CREATE INDEX IF NOT EXISTS idx_games_scores_diff_score ON games_scores(difficulty, score DESC);
  CREATE INDEX IF NOT EXISTS idx_games_scores_player_created ON games_scores(playerId, createdAt DESC);
`);

// ─── Chess saved games (Lichess-style library) ──────────────────
// One row per saved game. Stores the full PGN + final FEN + the metadata
// the FE needs to render the library card (engine name/type/strength,
// time control, result). No user auth — single-player portfolio toy.
db.exec(`
  CREATE TABLE IF NOT EXISTS chess_games (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    pgn             TEXT NOT NULL,             -- full PGN from chess.js
    fen             TEXT NOT NULL,             -- final position (so we can show a preview FEN)
    -- Who played: side is which colour the human took; null for pass-and-play.
    side            TEXT,                       -- 'white' | 'black' | NULL
    mode            TEXT NOT NULL,             -- 'play' | 'analyze' | 'human-vs-human'
    -- Engine metadata when the user played vs an engine. Schema is generic
    -- enough that future engines (Leela, custom, etc) slot in cleanly.
    engineName      TEXT,                       -- e.g. 'Stockfish'
    engineType      TEXT,                       -- e.g. 'stockfish' | 'leela' | 'fairy'
    engineStrength  INTEGER,                    -- ELO value used (1320-3190 for Stockfish)
    -- Time control id (none / bullet1 / blitz32 / ...) or 'custom'.
    timeControl     TEXT,
    -- Standard PGN result tags. '*' = in-progress / unfinished.
    result          TEXT NOT NULL DEFAULT '*',  -- '1-0' | '0-1' | '1/2-1/2' | '*'
    moveCount       INTEGER NOT NULL DEFAULT 0, -- number of half-moves (plies)
    createdAt       TEXT NOT NULL,
    updatedAt       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chess_games_updated ON chess_games(updatedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_chess_games_result  ON chess_games(result, updatedAt DESC);
`);
addColumnIfMissing('chess_games', 'collection', 'TEXT');

// ─── Chess online matches (live 1v1 via link share) ──────────────
// Lightweight live matchmaking — no auth, no accounts. Creator POSTs
// /chess/matches → gets a short matchId + a whiteSession token. Sends
// the matchId as a URL to a friend. Friend POSTs /chess/matches/:id/join
// → gets a blackSession token. Both sides submit moves with their
// session in the body; server validates the session against the side
// whose turn it is.
//
// Polling-based — clients hit /chess/matches/:id every ~1.5s for new
// state. Latency 1-2s is fine for a portfolio toy. Once the match
// completes (mate / draw / resign), the row stays for 24h then can be
// pruned; matches in 'waiting' or 'active' state without activity for
// 1h are eligible for cleanup too.
db.exec(`
  CREATE TABLE IF NOT EXISTS chess_matches (
    id              TEXT PRIMARY KEY,             -- short random id like 'abc12'
    status          TEXT NOT NULL DEFAULT 'waiting',  -- waiting | active | completed | aborted
    -- Side session tokens — only the holder of each can submit moves
    -- as that colour. Stored as random 24-char hex strings.
    whiteSession    TEXT NOT NULL,
    blackSession    TEXT,                          -- NULL until 2nd player joins
    whiteName       TEXT,                          -- optional display names
    blackName       TEXT,
    -- Game state
    fen             TEXT NOT NULL,
    pgn             TEXT NOT NULL DEFAULT '',
    sideToMove      TEXT NOT NULL DEFAULT 'w',     -- 'w' | 'b'
    moveCount       INTEGER NOT NULL DEFAULT 0,
    result          TEXT NOT NULL DEFAULT '*',     -- '1-0' | '0-1' | '1/2-1/2' | '*'
    -- Time control (optional, ms). Both clocks tick down on the BE
    -- via lastMoveAt diff so reconnects can't cheat the clock.
    timeControlId   TEXT,
    baseMs          INTEGER,
    incMs           INTEGER,
    whiteMs         INTEGER,
    blackMs         INTEGER,
    -- Timestamps
    createdAt       TEXT NOT NULL,
    updatedAt       TEXT NOT NULL,
    lastMoveAt      TEXT,                          -- when sideToMove's clock started
    completedAt     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chess_matches_status ON chess_matches(status, updatedAt DESC);
`);
// Per-side lastSeenAt — bumped on every GET /matches/:id?session=…. Used
// by the controller to auto-abort matches both players have walked away
// from (60s of silence). Lazy-added so older DBs migrate in place.
addColumnIfMissing('chess_matches', 'whiteLastSeenAt', 'TEXT');
addColumnIfMissing('chess_matches', 'blackLastSeenAt', 'TEXT');

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

// Lazy-add the analysis column for voice-clone / voice-sing rows. JSON string
// containing reference + cleaned + output audio stats, words_per_sec, etc.
// Old rows stay NULL; new voice jobs populate it.
addColumnIfMissing('audio_jobs',    'analysis', 'TEXT');
addColumnIfMissing('deepfake_jobs', 'analysis', 'TEXT');

// yt_jobs.worker — 'cobalt' (public API, instant, default) | 'home'
// (5090 worker on residential IP). Older rows default to 'cobalt' to
// keep behaviour unchanged for jobs created before this column existed.
addColumnIfMissing('yt_jobs', 'worker', "TEXT NOT NULL DEFAULT 'cobalt'");

// ─── Combined videos (ffmpeg concat from N library or uploaded videos) ──
// One row per "combine" job. Async — POST creates 'queued', the ffmpeg
// pass runs inline in a Promise (fast enough not to need RabbitMQ for
// portfolio-scale loads, ~10-60s for 4 clips). FE polls /status/:id.
// File auto-deletes on first download just like yt-dl.
db.exec(`
  CREATE TABLE IF NOT EXISTS combined_videos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sources       TEXT NOT NULL,                    -- JSON array of {videoId?, url?, title?}
    title         TEXT,                              -- user-supplied or auto-built
    status        TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | completed | failed
    progress      INTEGER NOT NULL DEFAULT 0,        -- 0..100
    strategy      TEXT,                              -- 'copy' | 'reencode' once done
    outputPath    TEXT,                              -- absolute disk path
    fileSize      INTEGER,
    error         TEXT,
    createdAt     TEXT NOT NULL,
    completedAt   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_combined_videos_status_created
    ON combined_videos(status, createdAt DESC);
`);

// ─── YouTube downloader (yt-dlp wrapper) ────────────────────────
// Each row is one download job. The BE spawns yt-dlp as a subprocess,
// streams stdout progress into the row, and on exit moves the final
// file path + size into place so the FE can offer a download. No
// queue — yt-dlp is CPU-only and downloads are bounded by network +
// the user's own click rate, so an in-process spawn is fine.
db.exec(`
  CREATE TABLE IF NOT EXISTS yt_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    url           TEXT NOT NULL,
    format        TEXT NOT NULL,                -- 'mp3' | 'mp4'
    quality       TEXT NOT NULL,                -- '128'|'192'|'320' | '360'|'720'|'1080'|'best'
    status        TEXT NOT NULL DEFAULT 'queued',  -- queued|processing|completed|failed
    progress      INTEGER NOT NULL DEFAULT 0,
    title         TEXT,
    duration      INTEGER,                       -- seconds
    fileSize      INTEGER,                       -- bytes
    fileName      TEXT,                          -- public-facing name
    filePath      TEXT,                          -- absolute disk path
    thumbnail     TEXT,
    error         TEXT,
    pid           INTEGER,
    createdAt     TEXT NOT NULL,
    completedAt   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_yt_jobs_status_created ON yt_jobs(status, createdAt DESC);
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

// ─── Cinema renders (per-attempt resumable render state) ───────
// One Cinema project can be rendered MANY times. Each render gets its
// own row here so the FE can drive the multi-shot chain client-side but
// the user can still:
//   • close the tab + come back to /cinema/render/:renderId and see
//     where the chain is
//   • refresh mid-flight without losing per-shot state
//   • share a render URL with someone else
//
// FE flow:
//   1. POST /api/cinema/:projectId/render → returns { renderId }
//   2. FE navigates to /cinema/render/:renderId
//   3. The render page reads state on mount + polls
//   4. FE chain PATCHes after every shot transition so the row stays in
//      sync with what the browser is doing
//
//   shotJobIds : JSON array of videoIds in order. Position N is null until
//                shot N kicks off, then becomes the videoId. Drives the
//                "which shots are done / which is current" UI without
//                needing a separate per-shot table.
//   combineJobId / finalDownloadHref : populated after the chain hits the
//                combine step.
db.exec(`
  CREATE TABLE IF NOT EXISTS cinema_renders (
    renderId          TEXT PRIMARY KEY,
    projectId         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'queued',
                                      -- queued | rendering | extracting | uploading |
                                      -- combining | completed | failed | cancelled
    phase             TEXT,           -- mirrors FE PHASES — for the status pill
    currentShotIndex  INTEGER NOT NULL DEFAULT 0,
    shotCount         INTEGER NOT NULL,
    shotJobIds        TEXT,           -- JSON array of videoIds, indexed by shot
    combineJobId      INTEGER,        -- id from combined_videos
    finalDownloadHref TEXT,           -- /api/combine/file/<id> for the stitched mp4
    error             TEXT,
    vault             INTEGER NOT NULL DEFAULT 0,
    createdAt         TEXT NOT NULL,
    updatedAt         TEXT NOT NULL,
    completedAt       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cinema_renders_project ON cinema_renders(projectId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_cinema_renders_status  ON cinema_renders(status, createdAt DESC);
`);

logger.info(`SQLite: ${DB_PATH} ready`);
