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

logger.info(`SQLite: ${DB_PATH} ready`);
