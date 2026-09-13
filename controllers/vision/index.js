// /api/vision/* — deep + light vision analysis, all on the BE.
//
// Endpoints:
//   POST /api/vision/analyze        Light OR deep, auto-upgrades to deep when
//                                   the Python face-service has the models loaded.
//                                   Returns `backend: 'light' | 'deep'`.
//   POST /api/vision/deep-analyze   Force the deep pipeline: BLIP caption +
//                                   CLIP zero-shot tags + InsightFace embeddings
//                                   + YOLOv8 objects + PaddleOCR + depth-map +
//                                   palette + aesthetic. Rich JSON, no client compute.
//   POST /api/vision/face-verify    Two images → cosine similarity on 512-dim
//                                   InsightFace embeddings → { same_person, similarity }.
//   GET  /api/vision/health         Diagnostics + which deep models are hot.
//
// Rate limits (naive Map, per-IP):
//   • /analyze         5 req/min
//   • /deep-analyze    3 req/min  (CPU-heavy)
//   • /face-verify     3 req/min  (two-image compute)
//
// Cache: SHA-256 of image bytes → 24h TTL. Same image never re-processes.
// The FE just uploads a file; the BE handles ALL model compute. Frontend
// never sees the model names — those are exposed under `models_used[]` and
// only surfaced to internal admin dashboards.

import crypto from 'crypto';
import multer from 'multer';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  offlineVisionAnalyze,
  deepVisionAnalyze,
  faceVerify as faceVerifyService,
  analyzeFace,
  detectObjects,
  ocrImage,
  dominantColors,
  fetchHealthDetail,
} from '../../services/face.js';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ─── SHA-256 cache (24h) — shared across all three POST endpoints ──
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

// ─── Per-IP rate limits (independent buckets per endpoint) ────────
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = {
  analyze: 5,
  deep: 3,
  verify: 3,
};
const rateBuckets = {
  analyze: new Map(),
  deep: new Map(),
  verify: new Map(),
};

function checkRate(bucket, ip) {
  const store = rateBuckets[bucket];
  const max = RATE_LIMITS[bucket];
  const now = Date.now();
  const arr = store.get(ip) || [];
  const pruned = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (pruned.length >= max) {
    store.set(ip, pruned);
    const retryAfterMs = Math.max(0, RATE_WINDOW_MS - (now - pruned[0]));
    return { ok: false, retryAfterMs, max };
  }
  pruned.push(now);
  store.set(ip, pruned);
  return { ok: true, max };
}

// ─── Multer memory storage (shared middleware for all image uploads) ──
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
// Two-image middleware for /face-verify — expects fields `imageA` + `imageB`.
export const visionVerifyUploadMiddleware = upload.fields([
  { name: 'imageA', maxCount: 1 },
  { name: 'imageB', maxCount: 1 },
]);

// ─── Normalisers (light + deep responses share most keys) ────────
function normaliseObjects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => ({
    label: o.label ?? o.class ?? 'object',
    confidence: Number(o.confidence ?? o.score ?? 0),
    bbox: Array.isArray(o.bbox) ? o.bbox.map((n) => Number(n)) : [0, 0, 0, 0],
  }));
}

function normaliseFacesLight(raw) {
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

// Deep faces come from InsightFace and already have age/gender/embedding_dim.
// Keep the raw 512-dim embedding gated behind `include_embedding` — otherwise
// we strip it to keep the response body small.
function normaliseFacesDeep(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => ({
    bbox: Array.isArray(f.bbox) ? f.bbox.map((n) => Number(n)) : [0, 0, 0, 0],
    landmarks_5pt: Array.isArray(f.landmarks_5pt) ? f.landmarks_5pt : [],
    age: f.age ?? null,
    gender: f.gender ?? null,
    emotion: f.emotion ?? f.mood ?? null,   // MediaPipe fallback carries `mood`
    det_score: Number(f.det_score ?? 0),
    embedding_dim: Number(f.embedding_dim ?? 0),
    // Only ship the vector if the Python side included it. We don't want to
    // leak 4 KB of floats on every request.
    embedding: Array.isArray(f.embedding) ? f.embedding : null,
    faceAngle: f.faceAngle ?? null,
    _fallback: f.fallback || null,
  }));
}

function normaliseText(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((w) => ({
    text: String(w.text || ''),
    confidence: Number(w.confidence ?? 0),
    bbox: Array.isArray(w.bbox) ? w.bbox.map((n) => Number(n)) : [0, 0, 0, 0],
    bbox_4pt: Array.isArray(w.bbox_4pt) ? w.bbox_4pt : undefined,
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

function normaliseTags(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => ({
    label: String(t.label || ''),
    score: Number(t.score ?? 0),
  }));
}

// ─── Fanout fallback (older Python service without /vision-analyze) ─
async function fanoutParallel(imageDataUri) {
  const [facesR, objectsR, ocrR, colorsR] = await Promise.allSettled([
    analyzeFace(imageDataUri),
    detectObjects(imageDataUri, 0.5),
    ocrImage(imageDataUri),
    dominantColors(imageDataUri, 6),
  ]);
  const warnings = [];
  const faces = facesR.status === 'fulfilled'
    ? normaliseFacesLight(facesR.value?.faces)
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

// Try the deep omnibus first; fall back to the light omnibus if the deep
// route is missing on the Python service (older build). Returns a unified
// payload plus a `backend` marker the caller can surface.
async function analyzeUnified(imageDataUri, { preferDeep = true, options = {} } = {}) {
  const warnings = [];

  if (preferDeep) {
    try {
      const raw = await deepVisionAnalyze(imageDataUri, options);
      if (raw && raw.ok !== false) {
        return {
          ok: true,
          backend: 'deep',
          caption: String(raw.caption || ''),
          confidence: Number(raw.confidence ?? 0),
          clip_tags: normaliseTags(raw.clip_tags),
          faces: normaliseFacesDeep(raw.faces),
          faceCount: Number(raw.faceCount ?? 0),
          face_backend: raw.face_backend || 'insightface',
          objects: normaliseObjects(raw.objects),
          objectCount: Number(raw.objectCount ?? 0),
          text: normaliseText(raw.text),
          ocr_available: !!raw.ocr_available,
          dominant_colors: normaliseColors(raw.dominant_colors),
          depth: raw.depth || { preview_url: null, stats: null, available: false },
          aesthetic: raw.aesthetic || { vibe: 'neutral', brightness: 0.5, saturation: 0.5 },
          meta: raw.meta || {},
          warnings: Array.isArray(raw.warnings) ? [...raw.warnings] : [],
          models_used: Array.isArray(raw.models_used) ? raw.models_used : [],
        };
      }
    } catch (deepErr) {
      logger.warn(`vision deep omnibus failed, falling back to light: ${deepErr.message}`);
      warnings.push(`deep_fallback: ${deepErr.message}`);
    }
  }

  // Light omnibus
  try {
    const raw = await offlineVisionAnalyze(imageDataUri, { threshold: 0.5, k: 6 });
    return {
      ok: true,
      backend: 'light',
      caption: '',
      confidence: 0,
      clip_tags: [],
      faces: normaliseFacesLight(raw.faces),
      faceCount: Number(raw.faceCount ?? 0),
      face_backend: 'mediapipe',
      objects: normaliseObjects(raw.objects),
      objectCount: Number(raw.objectCount ?? 0),
      text: normaliseText(raw.text),
      ocr_available: !!raw.ocr_available,
      dominant_colors: normaliseColors(raw.dominant_colors),
      depth: { preview_url: null, stats: null, available: false },
      aesthetic: { vibe: 'neutral', brightness: 0.5, saturation: 0.5 },
      meta: raw.meta || {},
      warnings: [...warnings, ...(Array.isArray(raw.warnings) ? raw.warnings : [])],
      models_used: ['MediaPipe', 'YOLOv8', 'Tesseract'],
    };
  } catch (lightErr) {
    // Both omnibuses down — fan out four requests as a last resort.
    logger.warn(`vision light omnibus failed, fanning out: ${lightErr.message}`);
    const fan = await fanoutParallel(imageDataUri);
    return {
      ok: true,
      backend: 'light',
      caption: '',
      confidence: 0,
      clip_tags: [],
      faces: fan.faces,
      faceCount: fan.faces.length,
      face_backend: 'mediapipe',
      objects: fan.objects,
      objectCount: fan.objects.length,
      text: fan.text,
      ocr_available: fan.ocr_available,
      dominant_colors: fan.dominant_colors,
      depth: { preview_url: null, stats: null, available: false },
      aesthetic: { vibe: 'neutral', brightness: 0.5, saturation: 0.5 },
      meta: fan.meta,
      warnings: [...warnings, `light_fallback: ${lightErr.message}`, ...fan.warnings],
      models_used: ['MediaPipe', 'YOLOv8', 'Tesseract'],
    };
  }
}

// Common upload-validation shard for the single-image endpoints.
function readUploadedImage(req, res) {
  if (!req.file) {
    error(res, 'Upload an image field named "image" (JPEG / PNG / WebP, ≤ 8 MB)', 400);
    return null;
  }
  const { buffer, mimetype, size, originalname } = req.file;
  if (!ALLOWED_MIME.has(mimetype)) {
    error(res, 'Only JPEG, PNG or WebP images are supported', 400);
    return null;
  }
  if (!buffer || !size) {
    error(res, 'Empty upload', 400);
    return null;
  }
  if (size > MAX_BYTES) {
    error(res, `Image too large (${(size / 1024 / 1024).toFixed(1)} MB, max 8 MB)`, 400);
    return null;
  }
  return { buffer, mimetype, size, originalname };
}

function clientIp(req) {
  return req.ip
    || req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
    || 'unknown';
}

// ─── POST /api/vision/analyze ────────────────────────────────────
// Auto-upgrades to the deep pipeline when the Python service has the models.
// Returns `backend: 'deep' | 'light'` so the FE can badge the response.
export const postVisionAnalyze = async (req, res) => {
  const ip = clientIp(req);
  const rate = checkRate('analyze', ip);
  if (!rate.ok) {
    res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000));
    return error(res, `Rate limit exceeded — ${rate.max} requests per minute. Retry in ${Math.ceil(rate.retryAfterMs / 1000)}s.`, 429);
  }

  const upload = readUploadedImage(req, res);
  if (!upload) return;
  const { buffer, mimetype, size, originalname } = upload;

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const cached = cacheGet(`analyze:${hash}`);
  if (cached) {
    return success(res, { ...cached, cached: true, imageHash: hash }, 'Cached');
  }

  const imageDataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const started = Date.now();

  try {
    const payload = await analyzeUnified(imageDataUri, { preferDeep: true });
    payload.elapsedMs = Date.now() - started;
    payload.imageHash = hash;
    payload.cached = false;

    cacheSet(`analyze:${hash}`, payload);
    logger.info(
      `vision/analyze OK · ${originalname || 'unnamed'} · ${(size / 1024).toFixed(0)}KB · ${payload.elapsedMs}ms · backend=${payload.backend} obj=${payload.objects.length} face=${payload.faces.length} txt=${payload.text.length} col=${payload.dominant_colors.length}`,
    );
    return success(res, payload, 'Analyzed');
  } catch (e) {
    logger.error('vision/analyze failed', e.message);
    return error(res, e.message || 'Vision analysis failed', 502);
  }
};

// ─── POST /api/vision/deep-analyze ───────────────────────────────
// Forces the deep pipeline. If any deep lane fails, the response body still
// carries the results of the lanes that succeeded — we never hard-fail on a
// single missing model.
export const postVisionDeepAnalyze = async (req, res) => {
  const ip = clientIp(req);
  const rate = checkRate('deep', ip);
  if (!rate.ok) {
    res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000));
    return error(res, `Rate limit exceeded — ${rate.max} deep requests per minute. Retry in ${Math.ceil(rate.retryAfterMs / 1000)}s.`, 429);
  }

  const upload = readUploadedImage(req, res);
  if (!upload) return;
  const { buffer, mimetype, size, originalname } = upload;

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const cached = cacheGet(`deep:${hash}`);
  if (cached) {
    return success(res, { ...cached, cached: true, imageHash: hash }, 'Cached');
  }

  const imageDataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const started = Date.now();

  try {
    // Deep-only — the caller explicitly asked for the deep pipeline. We still
    // return a payload if some lanes fail; the failures land in `warnings[]`.
    const payload = await analyzeUnified(imageDataUri, { preferDeep: true });
    payload.elapsedMs = Date.now() - started;
    payload.imageHash = hash;
    payload.cached = false;
    // If the deep call was silently downgraded (e.g. Python 404), surface it.
    if (payload.backend !== 'deep') {
      payload.warnings = [...(payload.warnings || []), 'deep pipeline unavailable — served light backend'];
    }

    cacheSet(`deep:${hash}`, payload);
    logger.info(
      `vision/deep-analyze OK · ${originalname || 'unnamed'} · ${(size / 1024).toFixed(0)}KB · ${payload.elapsedMs}ms · backend=${payload.backend} caption="${(payload.caption || '').slice(0, 60)}" tags=${payload.clip_tags.length} face=${payload.faces.length} obj=${payload.objects.length}`,
    );
    return success(res, payload, 'Deep-analyzed');
  } catch (e) {
    logger.error('vision/deep-analyze failed', e.message);
    return error(res, e.message || 'Deep vision analysis failed', 502);
  }
};

// ─── POST /api/vision/face-verify ────────────────────────────────
// Two-image face similarity via InsightFace 512-dim embeddings.
// multipart: imageA + imageB (fields), both JPEG/PNG/WebP, ≤ 8 MB each.
export const postFaceVerify = async (req, res) => {
  const ip = clientIp(req);
  const rate = checkRate('verify', ip);
  if (!rate.ok) {
    res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000));
    return error(res, `Rate limit exceeded — ${rate.max} verify requests per minute. Retry in ${Math.ceil(rate.retryAfterMs / 1000)}s.`, 429);
  }

  const filesA = req.files?.imageA;
  const filesB = req.files?.imageB;
  if (!filesA?.[0] || !filesB?.[0]) {
    return error(res, 'Upload two image fields named "imageA" and "imageB" (JPEG / PNG / WebP, ≤ 8 MB each)', 400);
  }
  const a = filesA[0];
  const b = filesB[0];
  for (const f of [a, b]) {
    if (!ALLOWED_MIME.has(f.mimetype)) {
      return error(res, 'Only JPEG, PNG or WebP images are supported', 400);
    }
    if (!f.buffer?.length || f.size > MAX_BYTES) {
      return error(res, `Image too large or empty (max 8 MB)`, 400);
    }
  }

  // Cache key = both hashes so the order matters (A→B and B→A hash differently
  // even though the result is symmetric; that's a tiny cache miss, no bug).
  const hashA = crypto.createHash('sha256').update(a.buffer).digest('hex');
  const hashB = crypto.createHash('sha256').update(b.buffer).digest('hex');
  const cacheKey = `verify:${hashA}:${hashB}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return success(res, { ...cached, cached: true }, 'Cached');
  }

  const uriA = `data:${a.mimetype};base64,${a.buffer.toString('base64')}`;
  const uriB = `data:${b.mimetype};base64,${b.buffer.toString('base64')}`;
  const started = Date.now();

  try {
    const raw = await faceVerifyService(uriA, uriB);
    const payload = {
      ok: true,
      same_person: !!raw.same_person,
      similarity: Number(raw.similarity ?? 0),
      threshold: Number(raw.threshold ?? 0.5),
      facesA: Number(raw.facesA ?? 0),
      facesB: Number(raw.facesB ?? 0),
      available: raw.available !== false,
      warning: raw.warning || null,
      backend: 'InsightFace buffalo_s',
      elapsedMs: Date.now() - started,
      cached: false,
    };
    cacheSet(cacheKey, payload);
    logger.info(
      `vision/face-verify OK · ${payload.same_person ? 'MATCH' : 'DIFF'} · sim=${payload.similarity} · thr=${payload.threshold} · ${payload.elapsedMs}ms`,
    );
    return success(res, payload, 'Verified');
  } catch (e) {
    logger.error('vision/face-verify failed', e.message);
    return error(res, e.message || 'Face verify failed', 502);
  }
};

// ─── GET /api/vision/health ──────────────────────────────────────
export const getVisionHealth = async (req, res) => {
  try {
    let detail = null;
    try { detail = await fetchHealthDetail(); } catch { /* ignore */ }
    return success(res, {
      ok: !!detail,
      backend: detail?.deep ? 'deep-available' : 'light-only',
      cacheSize: cache.size,
      maxBytes: MAX_BYTES,
      allowedMime: [...ALLOWED_MIME],
      rateLimit: {
        window_ms: RATE_WINDOW_MS,
        analyze_per_min: RATE_LIMITS.analyze,
        deep_analyze_per_min: RATE_LIMITS.deep,
        face_verify_per_min: RATE_LIMITS.verify,
      },
      pythonService: detail,
    });
  } catch (e) {
    return error(res, 'Face service unavailable', 503);
  }
};

// ─── Internal helper — reused by tattoo deep pipeline ───────────
// Runs the deep vision pipeline on an in-memory buffer. Skips multer / rate
// limit / cache — callers own those concerns. Returns the same normalised
// shape as postVisionDeepAnalyze so the tattoo controller can extract style,
// motifs, colours, etc. without a second HTTP hop through Node.
export async function analyzeBufferDeep(buffer, mimetype, options = {}) {
  if (!buffer || !buffer.length) throw new Error('Empty buffer');
  const imageDataUri = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  return analyzeUnified(imageDataUri, { preferDeep: true, options });
}

// Kept for backwards-compat with the previous tattoo fallback path — same
// signature as before but now silently prefers the deep pipeline if available.
export async function analyzeBufferOffline(buffer, mimetype) {
  return analyzeBufferDeep(buffer, mimetype, {});
}
