// /api/combine/* — multi-video concatenation.
//
//   POST   /api/combine               { sources: [{videoId?|url?, title?}], title? }
//   GET    /api/combine/list?limit=
//   GET    /api/combine/status/:id    polls progress + final state
//   GET    /api/combine/file/:id      streamed download with Content-Disposition
//   DELETE /api/combine/:id           removes row + on-disk file
//
// ffmpeg runs inline as a child process via combineVideos(); for a
// portfolio-scale combine (≤8 clips, ~30s total) the in-process spawn
// is plenty. Heavy multi-renders should later move behind a queue.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { combineVideos } from '../../services/ffmpeg/combine.js';
import {
  createCombine, getCombine, listCombines, updateCombine, deleteCombine,
} from '../../services/ffmpeg/combineStore.js';
import { appendLog as appendJobLog } from '../../services/aiVideo/logStore.js';
import { db } from '../../services/aiVideo/db.js';

// Local uploads land here so they can be fed straight to ffmpeg without
// a network round-trip. Cleaned by removeUpload (or never — these are
// small enough not to matter for now).
const ROOT = process.cwd();
export const COMBINE_UPLOADS_DIR = path.join(ROOT, 'data', 'combine-uploads');
fs.mkdirSync(COMBINE_UPLOADS_DIR, { recursive: true });

// In-memory registry of uploaded files. Keyed by uploadId → absolute
// path on disk. Survives until the process restarts; uploads picked up
// by a subsequent combine become permanent under their combineJob row
// (the file is read once at combine time, output written elsewhere).
const uploadRegistry = new Map();

// Resolve a source-spec to a concrete URL the ffmpeg helper can fetch.
// videoId hits the `videos` table for its Cloudinary videoUrl. A bare
// url passes through. Also returns the source row's vault flag so the
// controller can OR them together for the resulting combine row.
function resolveSource(spec) {
  if (spec?.url) return { url: spec.url, title: spec.title || null, vault: 0 };
  if (spec?.videoId) {
    const row = db.prepare(
      'SELECT videoId, videoUrl, prompt, vault FROM videos WHERE videoId = ?'
    ).get(spec.videoId);
    if (!row) throw new Error(`videoId ${spec.videoId} not found in library`);
    return {
      url: row.videoUrl,
      title: spec.title || row.prompt?.slice(0, 60) || row.videoId,
      vault: row.vault ? 1 : 0,
    };
  }
  // combineId — feed a previous combine's output back in as a source.
  // Lets users chain combines (e.g. combine A+B → that output + C).
  if (spec?.combineId) {
    const row = getCombine(parseInt(spec.combineId, 10));
    if (!row)                      throw new Error(`combineId ${spec.combineId} not found`);
    if (row.status !== 'completed') throw new Error(`combine ${spec.combineId} is ${row.status}, not completed`);
    if (!row.outputPath || !fs.existsSync(row.outputPath)) {
      throw new Error(`combine ${spec.combineId} file no longer on disk`);
    }
    return {
      url: row.outputPath,   // local path — ffmpeg reads directly
      title: spec.title || row.title || `combine-${row.id}`,
      vault: row.vault ? 1 : 0,
    };
  }
  // uploadId — local file the user dragged in via POST /api/combine/upload.
  if (spec?.uploadId) {
    const localPath = uploadRegistry.get(spec.uploadId);
    if (!localPath || !fs.existsSync(localPath)) {
      throw new Error(`uploadId ${spec.uploadId} not found (server restart?)`);
    }
    return {
      url: localPath,        // local path — bypass HTTP fetch
      title: spec.title || path.basename(localPath),
      vault: 0,
    };
  }
  throw new Error('source must have { videoId } or { url } or { combineId } or { uploadId }');
}

export const postCreate = async (req, res) => {
  try {
    const { sources, title } = req.body || {};
    if (!Array.isArray(sources) || sources.length < 2) {
      return error(res, 'sources must be an array of at least 2 videos', 400);
    }
    if (sources.length > 12) {
      return error(res, 'cap is 12 videos per combine (would take too long inline)', 400);
    }
    // Resolve every source up-front so we 400 early if a videoId is bad.
    let resolved;
    try { resolved = sources.map(resolveSource); }
    catch (err) { return error(res, err.message, 400); }

    // Vault propagation — if ANY source is from the vault library, the
    // combined output inherits the flag and stays hidden from anonymous
    // viewers. Pasted URLs default to vault=0 (we can't know their origin).
    const inheritVault = resolved.some(r => r.vault) ? 1 : 0;
    const job = createCombine({ sources: resolved, title, vault: inheritVault });

    // Fire-and-forget — controller returns immediately with the jobId;
    // FE polls /status/:id. ffmpeg writes progress/log into the row +
    // job_logs table for the live log feed.
    (async () => {
      updateCombine(job.id, { status: 'processing', progress: 0 });
      try {
        const result = await combineVideos(job.id, resolved.map(r => r.url), {
          onLog: (line) => appendJobLog(job.id, 'combine', line),
          onProgress: (pct) => updateCombine(job.id, { progress: pct }),
        });
        updateCombine(job.id, {
          status:      'completed',
          progress:    100,
          strategy:    result.strategy,
          outputPath:  result.outputPath,
          fileSize:    result.sizeBytes,
          completedAt: new Date().toISOString(),
        });
        appendJobLog(job.id, 'combine', `Combine ${job.id} complete (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${result.strategy})`);
        logger.info(`combine done jobId=${job.id} size=${result.sizeBytes} strategy=${result.strategy}`);
      } catch (err) {
        updateCombine(job.id, {
          status:      'failed',
          error:       String(err?.message || err).slice(0, 800),
          completedAt: new Date().toISOString(),
        });
        appendJobLog(job.id, 'combine', `Failed: ${err?.message || err}`);
        logger.warn(`combine failed jobId=${job.id}: ${err?.message || err}`);
      }
    })();

    return success(res, { jobId: job.id, status: job.status });
  } catch (err) {
    logger.error('combine postCreate failed', err.message);
    return error(res, err.message);
  }
};

export const getStatus = (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getCombine(id);
  if (!row) return error(res, 'combine job not found', 404);
  // Vault-private rows are 404 to anonymous viewers — same shape as a
  // genuinely missing id so we don't leak existence.
  if (row.vault && !req.vault) return error(res, 'combine job not found', 404);
  // Don't leak the absolute disk path.
  const { outputPath: _op, ...safe } = row;
  return success(res, safe);
};

// Paginated list. Query: ?visibility=public|vault&status=&page=&pageSize=
// pageSize is clamped server-side to [1, 1000]; default 20.
// visibility=vault only succeeds when req.vault is true; otherwise we
// silently coerce to 'public' so unauthenticated callers can't enumerate
// vaulted rows.
export const getList = (req, res) => {
  const visibility = (req.query.visibility || 'public').toLowerCase();
  const wantsVault = visibility === 'vault' && req.vault;
  const status = typeof req.query.status === 'string' && req.query.status
    ? req.query.status
    : undefined;
  const page     = parseInt(req.query.page, 10)     || 1;
  const pageSize = parseInt(req.query.pageSize, 10) || 20;
  const result = listCombines({ vault: wantsVault ? 1 : 0, status, page, pageSize });
  return success(res, { ...result, visibility: wantsVault ? 'vault' : 'public' });
};

// Auto-delete-on-first-download was REMOVED (2026-05-25) — it was a
// YT-DL-style privacy mirror that didn't fit the Combine + Cinema
// model. Combine outputs (especially Cinema renders) are deliverables
// the user wants to keep + re-download; nuking the file after the
// first save broke that. The file now persists until either:
//   • the user explicitly hits DELETE /api/combine/:id (removeJob), or
//   • a future sweeper cron evicts old rows (not wired yet).
// safelyDeleteFile() is left intact (still called by removeJob) for
// the explicit delete path.
const safelyDeleteFile = (id, filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    updateCombine(id, { outputPath: null });
    logger.info(`combine file deleted jobId=${id}`);
  } catch (err) {
    logger.warn(`combine file delete failed jobId=${id}: ${err.message}`);
  }
};

// slugify — turn a free-text title into something safe for a
// Content-Disposition filename. Strips diacritics, lowercases, replaces
// runs of non-alphanumerics with a single hyphen, trims to 60 chars so
// browsers don't choke on a 200-char name. Falls back to the id when
// the title is empty or all the characters got stripped.
const slugify = (raw, id) => {
  if (!raw || typeof raw !== 'string') return `combined-${id}`;
  const cleaned = raw
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned ? `${cleaned}-${id}` : `combined-${id}`;
};

export const streamFile = (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = getCombine(id);
  if (!row)                        return error(res, 'combine job not found', 404);
  if (row.vault && !req.vault)     return error(res, 'combine job not found', 404);
  if (row.status !== 'completed')  return error(res, `job is ${row.status}`, 400);
  if (!row.outputPath || !fs.existsSync(row.outputPath)) {
    return error(res, 'file no longer on disk', 410);
  }

  const stat = fs.statSync(row.outputPath);
  const fileSize = stat.size;
  const range = req.headers.range;
  // Derive a meaningful filename from the row's title (Cinema renders
  // pass "Cinema · <master prompt>..." as the title when they create
  // the combine; ad-hoc Build-tab combines pass the user-typed title).
  // ID is appended so two downloads of the same title stay distinct.
  const safeName = `${slugify(row.title, id)}.mp4`;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? Math.min(parseInt(m[2], 10), fileSize - 1) : fileSize - 1;
    if (start >= fileSize) { res.status(416).end(); return; }
    res.writeHead(206, {
      'Content-Range':   `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':   'bytes',
      'Content-Length':  end - start + 1,
      'Content-Type':    'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
    });
    fs.createReadStream(row.outputPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length':  fileSize,
      'Content-Type':    'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Accept-Ranges':   'bytes',
    });
    // No auto-delete after the response finishes — combine outputs
    // are deliverables the user expects to be able to re-download.
    // See safelyDeleteFile above for the long-form reason.
    fs.createReadStream(row.outputPath).pipe(res);
  }
};

export const removeJob = (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = getCombine(id);
  if (!row) return error(res, 'combine job not found', 404);
  // Deleting a vault-private combine requires vault auth — same gate as
  // any other destructive op on a vault asset.
  if (row.vault && !req.vault) return error(res, 'combine job not found', 404);
  if (row.outputPath) {
    try { fs.unlinkSync(row.outputPath); } catch {}
  }
  const ok = deleteCombine(id);
  return success(res, { ok });
};

// ── Upload endpoint ────────────────────────────────────────────────
// POST /api/combine/upload  (multipart: field name 'file')
// Stashes a user-supplied mp4 on disk + returns an uploadId the caller
// passes back inside the sources array on POST /api/combine. Files live
// under data/combine-uploads/ on the Oracle box so ffmpeg can read them
// directly without going back over HTTP.
const uploadStorage = multer.diskStorage({
  destination: COMBINE_UPLOADS_DIR,
  filename: (req, file, cb) => {
    const uploadId = crypto.randomUUID();
    const ext = (path.extname(file.originalname) || '.mp4').toLowerCase();
    cb(null, `${uploadId}${ext}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  // 500 MB cap — typical AI-generated clips are well under this.
  // Bumped from 200 MB after user feedback that some hand-shot mp4s
  // were over the limit.
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Permissive on content-type because browsers/iOS occasionally send
    // application/octet-stream for valid mp4s.
    const ok = /^video\//i.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    if (!ok) return cb(new Error(`unsupported mimetype ${file.mimetype}`));
    cb(null, true);
  },
});

export const uploadMiddleware = upload.single('file');

export const postUpload = (req, res) => {
  try {
    if (!req.file) return error(res, 'No file uploaded (expected field "file")', 400);
    // multer wrote the file to disk with its random-UUID filename. The
    // uploadId is just the filename without extension so we can recover
    // it from registry lookups.
    const uploadId = path.basename(req.file.filename, path.extname(req.file.filename));
    uploadRegistry.set(uploadId, req.file.path);
    return success(res, {
      uploadId,
      name:     req.file.originalname,
      size:     req.file.size,
      mimetype: req.file.mimetype,
    });
  } catch (err) {
    logger.error('combine upload failed', err.message);
    return error(res, err.message);
  }
};

// Restore upload registry on startup by scanning the on-disk directory.
// Without this, every restart loses references to uploads that haven't
// been used in a combine yet.
try {
  const files = fs.readdirSync(COMBINE_UPLOADS_DIR);
  for (const f of files) {
    const uploadId = path.basename(f, path.extname(f));
    uploadRegistry.set(uploadId, path.join(COMBINE_UPLOADS_DIR, f));
  }
  if (files.length) logger.info(`combine uploads · restored ${files.length} from disk`);
} catch (err) {
  logger.warn(`combine uploads · restore failed: ${err.message}`);
}
