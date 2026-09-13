// POST /api/tattoo/analyze — Tattoo → AI-styled QR analysis.
//
// Steps:
//   1. Validate: JPEG/PNG/WebP, ≤ 8 MB.
//   2. Hash the image bytes for the 24h cache key.
//   3. Base64 the buffer + hand it to services/tattoo/gemini.js.
//   4. Return { ok, analysis, cached } — the FE renders the analysis card
//      and can hand `suggested_qr_style` straight to the 2D editor.
//
// We use multer.memoryStorage instead of diskStorage — the file is <= 8 MB
// and we hash / base64 it once, no need to touch disk.

import crypto from 'crypto';
import multer from 'multer';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { analyzeTattooWithGemini } from '../../services/tattoo/gemini.js';
import { analyzeBufferOffline } from '../vision/index.js';
import { offlineToTattooShape } from '../../services/tattoo/offlineFallback.js';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// In-memory cache: sha256(image bytes) → { analysis, expiresAt }. Same
// process lifetime as the BE, no cross-instance sharing, but the hit rate
// on "user re-uploaded the same photo" is high enough to matter.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;   // rough LRU-ish upper bound
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Bump to most-recent on hit (Map iteration order = insertion order).
  cache.delete(key);
  cache.set(key, hit);
  return hit.analysis;
}

function cacheSet(key, analysis) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest entry.
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { analysis, expiresAt: Date.now() + CACHE_TTL_MS });
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
export const tattooUploadMiddleware = upload.single('image');

// ─── POST /api/tattoo/analyze ───────────────────────────────────
export const postAnalyzeTattoo = async (req, res) => {
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

  // Cache hit → return without spending a Gemini call.
  const hit = cacheGet(hash);
  if (hit) {
    return success(res, { analysis: hit, cached: true, imageHash: hash }, 'Cached');
  }

  try {
    const started = Date.now();
    const { analysis, modelId } = await analyzeTattooWithGemini({
      imageBase64: buffer.toString('base64'),
      mimeType: mimetype,
    });
    const elapsedMs = Date.now() - started;

    cacheSet(hash, analysis);

    logger.info(
      `tattoo/analyze OK · ${originalname || 'unnamed'} · ${(size / 1024).toFixed(0)}KB · ${modelId} · ${elapsedMs}ms · ${analysis.style} / ${analysis.energy}`,
    );

    return success(res, {
      analysis,
      cached: false,
      imageHash: hash,
      modelId,
      elapsedMs,
    }, 'Analyzed');
  } catch (e) {
    // Gemini failure → try the fully-offline vision pipeline (MediaPipe +
    // YOLO + Tesseract + k-means colours) so the Tattoo Studio keeps
    // working even when the Gemini key isn't configured. The offline
    // analysis is materially less rich (no tattoo-style classifier, no
    // subject description), so the response carries a warning + a
    // `backend: 'offline'` marker the FE can surface to the user.
    logger.warn(`tattoo/analyze Gemini failed (${e.code || 'error'}: ${e.message}) — falling back to offline vision`);
    try {
      const offlineStart = Date.now();
      const raw = await analyzeBufferOffline(buffer, mimetype);
      const analysis = offlineToTattooShape(raw);
      const elapsedMs = Date.now() - offlineStart;
      cacheSet(hash, analysis);
      logger.info(
        `tattoo/analyze OFFLINE OK · ${originalname || 'unnamed'} · ${(size / 1024).toFixed(0)}KB · ${elapsedMs}ms · ${analysis.motifs.length} motifs · ${analysis.dominant_colors.length} colors`,
      );
      return success(res, {
        analysis,
        cached: false,
        imageHash: hash,
        modelId: 'offline',
        elapsedMs,
        backend: 'offline',
        warnings: [
          e.code === 'GEMINI_DISABLED' || e.code === 'GEMINI_MISSING_KEY'
            ? 'Gemini is not configured — running offline vision. Install a Gemini key for richer style/subject detection.'
            : `Gemini call failed (${e.message}) — falling back to offline vision.`,
          ...(Array.isArray(raw.warnings) ? raw.warnings : []),
        ],
      }, 'Analyzed (offline)');
    } catch (offlineErr) {
      logger.error('tattoo/analyze offline fallback also failed', offlineErr.message);
      // Both lanes down — return the original Gemini error code so the FE
      // can distinguish "not set up" (503) from "Gemini errored" (502).
      if (e.code === 'GEMINI_DISABLED' || e.code === 'GEMINI_MISSING_KEY') {
        return error(res, `${e.message} — offline fallback also failed: ${offlineErr.message}`, 503);
      }
      return error(res, `${e.message || 'Analysis failed'} — offline fallback: ${offlineErr.message}`, 502);
    }
  }
};

// GET /api/tattoo/health — Ping the endpoint without spending a Gemini call.
export const getTattooHealth = (req, res) => {
  const configured = !!process.env.GEMINI_API_KEY;
  const enabled = (process.env.GEMINI_ENABLED || '').trim() === '1';
  return success(res, {
    ok: configured && enabled,
    configured,
    enabled,
    cacheSize: cache.size,
    maxBytes: MAX_BYTES,
    allowedMime: [...ALLOWED_MIME],
  });
};
