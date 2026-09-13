// POST /api/vision/analyze — Fully-offline vision analysis.
//
// Runs every offline model in parallel against a single uploaded image and
// returns a unified structured JSON blob. No Gemini / no cloud calls. The
// Tattoo Studio uses this as a fallback when Gemini is unavailable so the
// feature never returns 503 for missing keys.
//
// Lanes (each wrapped so one failure surfaces as a `warnings[]` entry
// instead of a 5xx):
//   • object detection  — YOLOv8-nano ONNX, via Python face-service
//   • face detection    — MediaPipe Face Mesh, via Python face-service
//   • OCR               — Tesseract (Python), soft-fails if binary missing
//   • dominant colours  — k-means k=6 on 64x64 downsample (OpenCV, Python)
//   • metadata          — width / height / aspect / brightness / contrast
//
// Colour extraction lives on the Python side (not sharp/jimp on Node) because
// this BE already ships OpenCV+numpy in the face-service and there's zero
// reason to add a native Node dep that has to build on ARM Oracle Cloud.
//
// Rate limit: 5 req/min/IP (naive Map).
// Cache: SHA-256 of image bytes → 24h TTL.
//
// Contract:
//   request  : multipart/form-data with `image` field (JPEG/PNG/WebP, ≤ 8 MB)
//   response : {
//     ok, objects[], text[], dominant_colors[], faces[], meta, warnings[],
//     backend: 'offline', cached, imageHash, elapsedMs
//   }

import crypto from 'crypto';
import multer from 'multer';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  offlineVisionAnalyze,
  analyzeFace,
  detectObjects,
  ocrImage,
  dominantColors,
} from '../../services/face.js';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ─── SHA-256 cache (24h) ─────────────────────────────────────────
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.payload;
}

function cacheSet(key, payload) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Naive per-IP rate limit (5 req/min) ─────────────────────────
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 5;
const rateBuckets = new Map(); // ip → [timestamps]

function checkRate(ip) {
  const now = Date.now();
  const arr = rateBuckets.get(ip) || [];
  const pruned = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (pruned.length >= RATE_MAX) {
    rateBuckets.set(ip, pruned);
    const oldest = pruned[0];
    const retryAfterMs = Math.max(0, RATE_WINDOW_MS - (now - oldest));
    return { ok: false, retryAfterMs };
  }
  pruned.push(now);
  rateBuckets.set(ip, pruned);
  return { ok: true };
}

// ─── Multer ──────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG or WebP images are supported'), false);
    }
    cb(null, true);
  },
});
export const visionUploadMiddleware = upload.single('image');

// ─── Unified shape ──────────────────────────────────────────────
// Even when the omnibus /vision-analyze endpoint is missing on an older
// Python service, we fall back to firing the individual lanes in parallel
// so the caller always gets the same shape.
function normaliseObjects(raw) {
  // Python /detect-objects returns {class, score, bbox}. /vision-analyze
  // already returns {label, confidence, bbox}. Normalise to the latter.
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => ({
    label: o.label ?? o.class ?? 'object',
    confidence: Number(o.confidence ?? o.score ?? 0),
    bbox: Array.isArray(o.bbox) ? o.bbox.map((n) => Number(n)) : [0, 0, 0, 0],
  }));
}

function normaliseFaces(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const bb = f.boundingBox || {};
    return {
      bbox: [bb.x || 0, bb.y || 0, bb.width || 0, bb.height || 0],
      landmarks: f.landmarks?.points || [],
      mood: f.mood || 'neutral',
      moodConfidence: f.moodConfidence ?? 0.5,
      faceAngle: f.faceAngle ?? 0,
      confidence: f.confidence ?? 0.9,
    };
  });
}

function normaliseText(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((w) => ({
    text: String(w.text || ''),
    confidence: Number(w.confidence ?? 0),
    bbox: Array.isArray(w.bbox) ? w.bbox.map((n) => Number(n)) : [0, 0, 0, 0],
  }));
}

function normaliseColors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).map((c) => ({
    hex: String(c.hex || '#000000'),
    rgb: Array.isArray(c.rgb) ? c.rgb.map((n) => Number(n)) : [0, 0, 0],
    weight: Number(c.weight ?? 0),
  }));
}

// Run all lanes individually with Promise.allSettled. Used as a fallback
// when the omnibus /vision-analyze route is missing (older Python service).
async function fanoutParallel(imageDataUri) {
  const [facesR, objectsR, ocrR, colorsR] = await Promise.allSettled([
    analyzeFace(imageDataUri),
    detectObjects(imageDataUri, 0.5),
    ocrImage(imageDataUri),
    dominantColors(imageDataUri, 6),
  ]);

  const warnings = [];
  const faces = facesR.status === 'fulfilled'
    ? normaliseFaces(facesR.value?.faces)
    : (warnings.push(`faces: ${facesR.reason?.message || 'failed'}`), []);
  const objects = objectsR.status === 'fulfilled'
    ? normaliseObjects(objectsR.value?.objects)
    : (warnings.push(`objects: ${objectsR.reason?.message || 'failed'}`), []);
  let text = [];
  let ocrAvailable = false;
  if (ocrR.status === 'fulfilled') {
    text = normaliseText(ocrR.value?.words);
    ocrAvailable = !!ocrR.value?.available;
    if (ocrR.value?.warning) warnings.push(`ocr: ${ocrR.value.warning}`);
  } else {
    warnings.push(`ocr: ${ocrR.reason?.message || 'failed'}`);
  }
  const colors = colorsR.status === 'fulfilled'
    ? normaliseColors(colorsR.value?.colors)
    : (warnings.push(`colors: ${colorsR.reason?.message || 'failed'}`), []);
  const meta = colorsR.status === 'fulfilled' ? (colorsR.value?.meta || {}) : {};

  return { faces, objects, text, dominant_colors: colors, meta, warnings, ocr_available: ocrAvailable };
}

// ─── POST /api/vision/analyze ────────────────────────────────────
export const postVisionAnalyze = async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || 'unknown';
  const rate = checkRate(ip);
  if (!rate.ok) {
    res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000));
    return error(res, `Rate limit exceeded — 5 requests per minute. Retry in ${Math.ceil(rate.retryAfterMs / 1000)}s.`, 429);
  }

  if (!req.file) {
    return error(res, 'Upload an image field named "image" (JPEG / PNG / WebP, ≤ 8 MB)', 400);
  }

  const { buffer, mimetype, size, originalname } = req.file;
  if (!ALLOWED_MIME.has(mimetype)) {
    return error(res, 'Only JPEG, PNG or WebP images are supported', 400);
  }
  if (!buffer || !size) {
    return error(res, 'Empty upload', 400);
  }
  if (size > MAX_BYTES) {
    return error(res, `Image too large (${(size / 1024 / 1024).toFixed(1)} MB, max 8 MB)`, 400);
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Cache hit — skip all the compute.
  const cached = cacheGet(hash);
  if (cached) {
    return success(res, { ...cached, cached: true, imageHash: hash }, 'Cached');
  }

  const imageDataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const started = Date.now();

  try {
    // Prefer the omnibus endpoint — one HTTP hop, one image decode.
    let payload;
    try {
      const raw = await offlineVisionAnalyze(imageDataUri, { threshold: 0.5, k: 6 });
      payload = {
        ok: true,
        objects: normaliseObjects(raw.objects),
        text: normaliseText(raw.text),
        dominant_colors: normaliseColors(raw.dominant_colors),
        faces: normaliseFaces(raw.faces),
        meta: raw.meta || {},
        ocr_available: !!raw.ocr_available,
        warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
        backend: 'offline',
      };
    } catch (omniErr) {
      // Fall back to firing lanes individually if the Python service is
      // running an older build without /vision-analyze.
      logger.warn(`vision/analyze omnibus failed, falling back to fanout: ${omniErr.message}`);
      const fanout = await fanoutParallel(imageDataUri);
      payload = { ok: true, ...fanout, backend: 'offline' };
      payload.warnings.push(`omnibus_fallback: ${omniErr.message}`);
    }

    const elapsedMs = Date.now() - started;
    payload.elapsedMs = elapsedMs;
    payload.imageHash = hash;
    payload.cached = false;

    cacheSet(hash, payload);

    logger.info(
      `vision/analyze OK · ${originalname || 'unnamed'} · ${(size / 1024).toFixed(0)}KB · ${elapsedMs}ms · obj=${payload.objects.length} face=${payload.faces.length} txt=${payload.text.length} col=${payload.dominant_colors.length}`,
    );

    return success(res, payload, 'Analyzed');
  } catch (e) {
    logger.error('vision/analyze failed', e.message);
    return error(res, e.message || 'Vision analysis failed', 502);
  }
};

// GET /api/vision/health — diagnostics without spending a full analyze call.
export const getVisionHealth = async (req, res) => {
  try {
    const { checkHealth } = await import('../../services/face.js');
    const healthy = await checkHealth();
    return success(res, {
      ok: healthy,
      backend: 'offline',
      cacheSize: cache.size,
      maxBytes: MAX_BYTES,
      allowedMime: [...ALLOWED_MIME],
      rateLimit: { window_ms: RATE_WINDOW_MS, max: RATE_MAX },
    });
  } catch (e) {
    return error(res, 'Face service unavailable', 503);
  }
};

// ─── Internal helper — reused by tattoo fallback ────────────────
// Runs the full offline analyze on an in-memory buffer and returns the
// normalised payload. Skips multer / rate limit / cache — the caller
// already handles those concerns.
export async function analyzeBufferOffline(buffer, mimetype) {
  if (!buffer || !buffer.length) throw new Error('Empty buffer');
  const imageDataUri = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  try {
    const raw = await offlineVisionAnalyze(imageDataUri, { threshold: 0.5, k: 6 });
    return {
      ok: true,
      objects: normaliseObjects(raw.objects),
      text: normaliseText(raw.text),
      dominant_colors: normaliseColors(raw.dominant_colors),
      faces: normaliseFaces(raw.faces),
      meta: raw.meta || {},
      ocr_available: !!raw.ocr_available,
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      backend: 'offline',
    };
  } catch (omniErr) {
    const fanout = await fanoutParallel(imageDataUri);
    return { ok: true, ...fanout, backend: 'offline', warnings: [...fanout.warnings, `omnibus_fallback: ${omniErr.message}`] };
  }
}
