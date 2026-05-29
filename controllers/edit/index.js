// /api/edit/* — Video editor library (OpenReel exports).
//
// Endpoints
//   POST   /api/edit/upload                multipart 'video' → { id, url, bytes, vault }
//   GET    /api/edit/list?vaultOnly=…      list of saved edits (vault items hidden if not logged in)
//   GET    /api/edit/file/:id.mp4          stream the MP4 with Range support
//   GET    /api/edit/poster/:id.jpg        first-frame thumbnail (ffmpeg-extracted lazily on first request)
//   DELETE /api/edit/:id                   vault-required
//   POST   /api/edit/bulk-delete           vault-required, body { ids: [...] }
//
// Storage: data/edit-library/<id>.mp4 + <id>.json (sidecar metadata).
// Posters are lazy-generated at data/edit-library/<id>.jpg on first
// request to keep upload fast.
//
// Vault model:
//   - Anonymous uploads land with vault=0 (public).
//   - Vault-token uploads land with vault=1 (private).
//   - GET /list with no vault token hides vault rows entirely.
//   - DELETE / bulk-delete always require the vault token.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import multer from "multer";
import logger from "../../helpers/logger.js";
import { success, error } from "../../helpers/res_helper.js";

const ROOT      = process.cwd();
const LIB_DIR   = path.join(ROOT, "data", "edit-library");
fs.mkdirSync(LIB_DIR, { recursive: true });

const VALID_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv"]);
const MAX_BYTES  = 500 * 1024 * 1024;   // 500 MB cap per video — communicated to the user via the editor hint banner

// ─── multer setup ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LIB_DIR),
  filename:    (_req, file, cb) => {
    const id  = crypto.randomBytes(8).toString("hex");
    const ext = (path.extname(file.originalname || "") || ".mp4").toLowerCase();
    if (!VALID_EXTS.has(ext)) return cb(new Error(`Unsupported extension: ${ext}`));
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_BYTES } });
export const editUploadMiddleware = upload.single("video");

// ─── sidecar JSON metadata ────────────────────────────────────
function sidecarPath(id) { return path.join(LIB_DIR, `${id}.json`); }

function readSidecar(id) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(id), "utf8"));
  } catch { return null; }
}

function writeSidecar(id, data) {
  try { fs.writeFileSync(sidecarPath(id), JSON.stringify(data)); } catch (e) {
    logger.warn(`[edit] sidecar write failed for ${id}: ${e.message}`);
  }
}

function findVideoFile(id) {
  for (const ext of VALID_EXTS) {
    const p = path.join(LIB_DIR, `${id}${ext}`);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}

// Loose ID validator — prevents path traversal.
const ID_RE = /^[a-f0-9]{16}$/i;
const isSafeId = (id) => ID_RE.test(id);

// ─── POST /api/edit/upload ────────────────────────────────────
export const postEditUpload = (req, res) => {
  if (!req.file) return error(res, "Upload a 'video' field", 400);
  const fullName = req.file.filename;
  const id       = path.parse(fullName).name;
  const ext      = path.extname(fullName);
  const vault    = req.vault?.unlocked ? 1 : 0;

  const meta = {
    id,
    ext,
    title:       (req.body?.title || "").slice(0, 120) || "Untitled edit",
    aspectRatio: (req.body?.aspectRatio || "").slice(0, 16) || null,
    durationSec: parseFloat(req.body?.durationSec) || null,
    bytes:       req.file.size,
    vault,
    createdAt:   new Date().toISOString(),
  };
  writeSidecar(id, meta);

  logger.info(`[edit/upload] ${id} · ${(req.file.size / (1024 * 1024)).toFixed(1)} MB · vault=${vault}`);
  return success(res, {
    ...meta,
    url:    `/api/edit/file/${id}${ext}`,
    poster: `/api/edit/poster/${id}.jpg`,
  });
};

// ─── GET /api/edit/list ──────────────────────────────────────
// Vault-aware: anonymous callers never see vault=1 rows.
export const getEditList = (_req, res) => {
  const isVault = !!_req.vault?.unlocked;
  const entries = fs.readdirSync(LIB_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      const id = path.parse(n).name;
      return readSidecar(id);
    })
    .filter((m) => !!m && (isVault || !m.vault))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const items = entries.map((m) => ({
    ...m,
    url:    `/api/edit/file/${m.id}${m.ext || ".mp4"}`,
    poster: `/api/edit/poster/${m.id}.jpg`,
  }));
  return success(res, { items, count: items.length, vaultUnlocked: isVault });
};

// ─── GET /api/edit/file/:id.<ext> ─────────────────────────────
export const getEditFile = (req, res) => {
  const raw = String(req.params.name || "");
  if (!/^[a-f0-9]{16}\.[a-z0-9]+$/i.test(raw)) return error(res, "Bad id", 400);
  const id  = path.parse(raw).name;
  const found = findVideoFile(id);
  if (!found) return error(res, "Not found", 404);
  const meta = readSidecar(id);

  // Vault rows aren't streamed to anonymous callers.
  if (meta?.vault && !req.vault?.unlocked) return error(res, "Vault required", 401);

  const stat = fs.statSync(found.path);
  res.setHeader("Content-Type",  found.ext === ".webm" ? "video/webm" : "video/mp4");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", meta?.vault ? "private, max-age=300" : "public, max-age=86400");
  res.setHeader("Content-Disposition", `inline; filename="${raw}"`);

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end   = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      res.status(206);
      res.setHeader("Content-Range",  `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Accept-Ranges",  "bytes");
      res.setHeader("Content-Length", end - start + 1);
      return fs.createReadStream(found.path, { start, end }).pipe(res);
    }
  }
  fs.createReadStream(found.path).pipe(res);
};

// ─── GET /api/edit/poster/:id.jpg ─────────────────────────────
// Lazy-extracts a thumbnail from the first second on first request.
export const getEditPoster = async (req, res) => {
  const raw = String(req.params.name || "");
  if (!/^[a-f0-9]{16}\.jpg$/i.test(raw)) return error(res, "Bad id", 400);
  const id   = path.parse(raw).name;
  const dest = path.join(LIB_DIR, `${id}.jpg`);

  if (!fs.existsSync(dest)) {
    const found = findVideoFile(id);
    if (!found) return error(res, "Not found", 404);
    const meta = readSidecar(id);
    if (meta?.vault && !req.vault?.unlocked) return error(res, "Vault required", 401);

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", [
          "-y",
          "-ss", "00:00:01",
          "-i", found.path,
          "-frames:v", "1",
          "-vf", "scale=480:-2",
          "-q:v", "5",
          dest,
        ], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("error", reject);
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(err.slice(-200))));
      });
    } catch (e) {
      logger.warn(`[edit/poster] extract failed for ${id}: ${e.message}`);
      return error(res, "Poster extraction failed", 500);
    }
  }

  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(dest).pipe(res);
};

// ─── DELETE /api/edit/:id ─────────────────────────────────────
export const deleteEdit = (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return error(res, "Bad id", 400);
  const found = findVideoFile(id);
  if (!found) return error(res, "Not found", 404);
  try {
    fs.unlinkSync(found.path);
    try { fs.unlinkSync(sidecarPath(id)); } catch (_) {}
    try { fs.unlinkSync(path.join(LIB_DIR, `${id}.jpg`)); } catch (_) {}
  } catch (e) {
    return error(res, `Could not delete: ${e.message}`, 500);
  }
  logger.info(`[edit/delete] removed ${id}`);
  return success(res, { id, deleted: true });
};

// ─── POST /api/edit/bulk-delete ───────────────────────────────
export const postEditBulkDelete = (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) return error(res, "ids[] required", 400);
  const results = ids.map((id) => {
    if (!isSafeId(id)) return { id, ok: false, error: "bad id" };
    const found = findVideoFile(id);
    if (!found) return { id, ok: false, error: "not found" };
    try {
      fs.unlinkSync(found.path);
      try { fs.unlinkSync(sidecarPath(id)); } catch (_) {}
      try { fs.unlinkSync(path.join(LIB_DIR, `${id}.jpg`)); } catch (_) {}
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, error: e.message };
    }
  });
  const ok = results.filter((r) => r.ok).length;
  logger.info(`[edit/bulk-delete] ${ok}/${results.length} removed`);
  return success(res, { results, ok, total: results.length });
};
