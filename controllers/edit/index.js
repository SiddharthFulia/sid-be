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
import os from "os";
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

// ─── POST /api/edit/process ───────────────────────────────────
// Server-side ffmpeg trim + aspect-crop + optional music mix.
// Multer accepts BOTH 'video' (required) and 'music' (optional)
// — multer.fields() lets us multiplex one POST for the whole edit.
const processStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const t = path.join(os.tmpdir(), `edit_${crypto.randomBytes(6).toString("hex")}`);
    fs.mkdirSync(t, { recursive: true });
    cb(null, t);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || (file.fieldname === "music" ? ".mp3" : ".mp4");
    cb(null, `${file.fieldname}${ext}`);
  },
});
const processUpload = multer({
  storage: processStorage,
  limits:  { fileSize: MAX_BYTES },
});
export const editProcessMiddleware = processUpload.fields([
  { name: "video", maxCount: 1 },
  { name: "music", maxCount: 1 },
]);

// Aspect-ratio crop. ffmpeg `crop=W:H:(in_w-W)/2:(in_h-H)/2` keeps
// the center of the frame. For each preset we compute target W/H
// from the source dimensions so we never upscale, only crop.
//
// Returns the ffmpeg `-vf` filter chain (without the `-vf` flag).
function buildVideoFilter(aspect) {
  if (!aspect || aspect === "source") return null;
  const [aw, ah] = aspect.split(":").map(Number);
  if (!aw || !ah) return null;
  // ffmpeg expression: target = min(iw, ih*ar) × min(iw/ar, ih)
  // Computed inline via filter expression so we don't need to read
  // the source dimensions up-front with ffprobe.
  const arN = `${aw}`, arD = `${ah}`;
  return [
    `crop='if(gt(iw/ih,${arN}/${arD}),floor(ih*${arN}/${arD}/2)*2,iw)':`
        + `'if(gt(iw/ih,${arN}/${arD}),ih,floor(iw*${arD}/${arN}/2)*2)':`
        + `'(in_w-out_w)/2':'(in_h-out_h)/2'`,
    // Even resize to keep H.264 happy (must be /2 width/height).
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
  ].join(",");
}

function ffmpegRun(args, label = "ffmpeg") {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", (e) => reject(new Error(`${label} spawn failed: ${e.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${label} exit ${code}: ${err.slice(-400)}`));
      resolve();
    });
  });
}

export const postEditProcess = async (req, res) => {
  const videoFiles = req.files?.video || [];
  const musicFiles = req.files?.music || [];
  if (videoFiles.length === 0) return error(res, "Upload a 'video' field", 400);

  const inVideo = videoFiles[0].path;
  const inMusic = musicFiles[0]?.path || null;
  const tmpDir  = path.dirname(inVideo);

  // Pull edit params from the form body.
  const trimStart   = Math.max(0, parseFloat(req.body?.trimStart) || 0);
  const trimEndRaw  = parseFloat(req.body?.trimEnd);
  const trimEnd     = Number.isFinite(trimEndRaw) && trimEndRaw > trimStart ? trimEndRaw : null;
  const aspect      = String(req.body?.aspectRatio || "source");
  const musicVolume = Math.max(0, Math.min(1, parseFloat(req.body?.musicVolume) || 0.7));
  const title       = (req.body?.title || "Untitled edit").slice(0, 120);
  const vault       = req.vault?.unlocked ? 1 : 0;

  const id   = crypto.randomBytes(8).toString("hex");
  const out  = path.join(LIB_DIR, `${id}.mp4`);

  try {
    // Build the ffmpeg command.
    const args = ["-y"];
    if (trimStart > 0) args.push("-ss", trimStart.toFixed(2));
    args.push("-i", inVideo);
    if (inMusic) {
      if (trimStart > 0) args.push("-ss", trimStart.toFixed(2));
      args.push("-i", inMusic);
    }
    if (trimEnd != null) args.push("-t", (trimEnd - trimStart).toFixed(2));

    // Video filter (aspect crop) — applied to stream 0.
    const vf = buildVideoFilter(aspect);
    if (vf) args.push("-vf", vf);

    if (inMusic) {
      // Mix music with original audio. amix balances both inputs;
      // we boost music by musicVolume and softly duck the source.
      const amix =
        `[0:a]volume=${(1 - musicVolume * 0.6).toFixed(2)}[va];` +
        `[1:a]volume=${musicVolume.toFixed(2)}[ma];` +
        `[va][ma]amix=inputs=2:duration=shortest:dropout_transition=0[aout]`;
      args.push("-filter_complex", amix, "-map", "0:v", "-map", "[aout]");
    }

    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "192k",
      out
    );

    logger.info(`[edit/process] ${id} · ${title} · aspect=${aspect} trim=${trimStart}->${trimEnd} music=${!!inMusic}`);
    await ffmpegRun(args, "edit-process");

    const stat = fs.statSync(out);
    const meta = {
      id,
      ext:         ".mp4",
      title,
      aspectRatio: aspect === "source" ? null : aspect,
      durationSec: trimEnd != null ? trimEnd - trimStart : parseFloat(req.body?.durationSec) || null,
      bytes:       stat.size,
      vault,
      createdAt:   new Date().toISOString(),
    };
    writeSidecar(id, meta);

    return success(res, {
      ...meta,
      url:    `/api/edit/file/${id}.mp4`,
      poster: `/api/edit/poster/${id}.jpg`,
    });
  } catch (e) {
    logger.error(`[edit/process] failed: ${e.message}`);
    try { fs.unlinkSync(out); } catch (_) {}
    return error(res, e.message || "Render failed", 500);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
};
