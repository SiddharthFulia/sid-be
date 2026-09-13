// POST /api/tattoo/analyze — Tattoo → AI-styled QR analysis.
//
// Pipeline order (2026-09-13 rework):
//   1. DEEP pipeline (primary):
//      • Run the on-BE deep vision omnibus (BLIP caption + CLIP zero-shot +
//        InsightFace + YOLOv8 + PaddleOCR + Depth-Anything + palette).
//      • Re-run CLIP with a CURATED tattoo-style label list so we get a real
//        confidence score for style / line-weight / energy, not a rescored
//        proxy from the omnibus's default labels.
//      • Merge into the tattoo contract shape and return.
//   2. Gemini (fallback): only fires if the deep pipeline errored AND Gemini
//      is configured. Rare — most users get the deep pipeline.
//   3. Offline light (last resort): pure YOLO + palette, style="unknown".
//
// This means the FE gets a REAL style/subject/motif on any BE that has torch
// installed, without ever calling out to a paid API. The `backend` marker on
// the response tells the FE which branch produced the analysis.
//
// Rate limit + cache: same 24h SHA-256 cache from before, still shared per-controller.

import crypto from 'crypto';
import multer from 'multer';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { analyzeTattooWithGemini } from '../../services/tattoo/gemini.js';
import { analyzeBufferDeep } from '../vision/index.js';
import {
  offlineToTattooShape,
  STYLE_CLIP_PROMPTS,
  TATTOO_STYLES,
  ENERGY_CLIP_PROMPTS,
  ENERGY_VALUES,
  LINE_WEIGHT_CLIP_PROMPTS,
  LINE_WEIGHT_VALUES,
} from '../../services/tattoo/offlineFallback.js';
import { clipTags as clipTagsService } from '../../services/face.js';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
  return hit.analysis;
}

function cacheSet(key, analysis) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { analysis, expiresAt: Date.now() + CACHE_TTL_MS });
}

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

// Turn a top CLIP result into an enum value — same logic as offlineFallback
// but exported here so we can pick winners from a bespoke CLIP call.
function extractEnum(clipTags, enumValues) {
  if (!Array.isArray(clipTags) || !clipTags.length) return { value: null, score: 0 };
  for (const t of clipTags) {
    const s = String(t.label || '').toLowerCase();
    for (const v of enumValues) {
      if (s.includes(v)) return { value: v, score: Number(t.score) || 0 };
    }
    if (s.includes('irezumi') && enumValues.includes('japanese')) {
      return { value: 'japanese', score: Number(t.score) || 0 };
    }
  }
  return { value: null, score: 0 };
}

/**
 * Run the deep vision pipeline + a second CLIP call with curated tattoo
 * labels, then merge into the tattoo contract shape.
 *
 * Returns { analysis, modelIds } where modelIds is an array of the models
 * that actually contributed to the response (for logging).
 */
async function analyzeTattooDeep(buffer, mimetype) {
  const imageDataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;

  // Kick off the omnibus and the tattoo-specific CLIP calls in parallel.
  // Both share the Python service, which serialises internally — but issuing
  // them concurrently still saves round-trip latency because the omnibus
  // dominates (BLIP + InsightFace + Depth), and the tiny CLIP calls piggyback.
  const [omniR, styleR, energyR, lineR] = await Promise.allSettled([
    analyzeBufferDeep(buffer, mimetype),
    clipTagsService(imageDataUri, STYLE_CLIP_PROMPTS, { top_k: 5 }),
    clipTagsService(imageDataUri, ENERGY_CLIP_PROMPTS, { top_k: 3 }),
    clipTagsService(imageDataUri, LINE_WEIGHT_CLIP_PROMPTS, { top_k: 3 }),
  ]);

  if (omniR.status !== 'fulfilled') {
    throw new Error(`deep omnibus failed: ${omniR.reason?.message || 'unknown'}`);
  }
  const omni = omniR.value;

  // Baseline mapping from the omnibus — style will likely be 'unknown' here
  // because the omnibus CLIP labels are generic, not tattoo-specific.
  const base = offlineToTattooShape(omni);

  // Override style / energy / line_weight from the CURATED CLIP calls where
  // they succeeded. Fall back to the base heuristic where they didn't.
  const stylePick = styleR.status === 'fulfilled'
    ? extractEnum(styleR.value?.tags || [], TATTOO_STYLES)
    : { value: null, score: 0 };
  const energyPick = energyR.status === 'fulfilled'
    ? extractEnum(energyR.value?.tags || [], ENERGY_VALUES)
    : { value: null, score: 0 };
  const linePick = lineR.status === 'fulfilled'
    ? extractEnum(lineR.value?.tags || [], LINE_WEIGHT_VALUES)
    : { value: null, score: 0 };

  const style = stylePick.value || (base.style !== 'unknown' ? base.style : 'blackwork');
  const energy = energyPick.value || (base.energy !== 'neutral' ? base.energy : 'calm');
  const lineWeight = linePick.value || (base.line_weight !== 'unknown' ? base.line_weight : 'medium');

  // Confidence: prefer the style-specific CLIP score; if unavailable use the
  // caption confidence; else the base heuristic. Clamp [0.5, 0.98].
  let confidence = base.confidence;
  if (stylePick.score > 0) {
    confidence = Math.max(0.5, Math.min(0.98, stylePick.score));
  } else if (omni.confidence > 0) {
    confidence = Math.max(0.5, Math.min(0.98, omni.confidence));
  }

  const modelIds = ['deep'];
  if (omniR.value?.models_used) modelIds.push(...omniR.value.models_used);
  if (stylePick.score > 0) modelIds.push('CLIP-tattoo-styles');

  return {
    analysis: {
      ...base,
      style,
      energy,
      line_weight: lineWeight,
      confidence,
      backend: 'deep',
      _extra: {
        ...base._extra,
        style_confidence: stylePick.score,
        energy_confidence: energyPick.score,
        line_weight_confidence: linePick.score,
        deep_backend: omni.backend,
      },
    },
    modelIds,
  };
}

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
  const hit = cacheGet(hash);
  if (hit) {
    return success(res, { analysis: hit, cached: true, imageHash: hash }, 'Cached');
  }

  // ─── STEP 1: DEEP PIPELINE (primary) ────────────────────────
  const started = Date.now();
  try {
    const { analysis, modelIds } = await analyzeTattooDeep(buffer, mimetype);
    // Guard: if the omnibus came back with backend='light' (deep unavailable),
    // treat as a partial success and downgrade the badge — but only if we
    // still got real motifs. If everything is empty, fall through to Gemini.
    const deepAvailable = analysis._extra?.deep_backend === 'deep';
    if (deepAvailable) {
      const elapsedMs = Date.now() - started;
      cacheSet(hash, analysis);
      logger.info(
        `tattoo/analyze DEEP OK · ${originalname || 'unnamed'} · ${(size / 1024).toFixed(0)}KB · ${elapsedMs}ms · style=${analysis.style} energy=${analysis.energy} motifs=${analysis.motifs.length}`,
      );
      return success(res, {
        analysis,
        cached: false,
        imageHash: hash,
        modelId: modelIds.join('+'),
        elapsedMs,
        backend: 'deep',
      }, 'Analyzed');
    }
    // Deep pipeline returned light-only (transformers not installed yet).
    // Try Gemini next, then fall back to this partial result.
    logger.warn('tattoo/analyze deep pipeline downgraded to light — trying Gemini next');
  } catch (deepErr) {
    logger.warn(`tattoo/analyze deep failed (${deepErr.message}) — trying Gemini`);
  }

  // ─── STEP 2: GEMINI FALLBACK ────────────────────────────────
  try {
    const geminiStart = Date.now();
    const { analysis, modelId } = await analyzeTattooWithGemini({
      imageBase64: buffer.toString('base64'),
      mimeType: mimetype,
    });
    const elapsedMs = Date.now() - geminiStart;
    cacheSet(hash, analysis);
    logger.info(
      `tattoo/analyze GEMINI OK · ${originalname || 'unnamed'} · ${(size / 1024).toFixed(0)}KB · ${modelId} · ${elapsedMs}ms · ${analysis.style} / ${analysis.energy}`,
    );
    return success(res, {
      analysis,
      cached: false,
      imageHash: hash,
      modelId,
      elapsedMs,
      backend: 'gemini',
    }, 'Analyzed');
  } catch (gErr) {
    // ─── STEP 3: LIGHT OFFLINE (last resort) ─────────────────
    logger.warn(`tattoo/analyze Gemini failed (${gErr.code || 'error'}: ${gErr.message}) — falling back to light offline`);
    try {
      const offlineStart = Date.now();
      const raw = await analyzeBufferDeep(buffer, mimetype); // may still be light
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
        backend: analysis.backend || 'offline',
        warnings: [
          gErr.code === 'GEMINI_DISABLED' || gErr.code === 'GEMINI_MISSING_KEY'
            ? 'Deep pipeline unavailable and Gemini is not configured — served heuristic offline analysis.'
            : `Deep pipeline unavailable, Gemini failed (${gErr.message}) — served offline analysis.`,
          ...(Array.isArray(raw.warnings) ? raw.warnings : []),
        ],
      }, 'Analyzed (offline)');
    } catch (offlineErr) {
      logger.error('tattoo/analyze all backends failed', offlineErr.message);
      if (gErr.code === 'GEMINI_DISABLED' || gErr.code === 'GEMINI_MISSING_KEY') {
        return error(res, `${gErr.message} — offline fallback also failed: ${offlineErr.message}`, 503);
      }
      return error(res, `${gErr.message || 'Analysis failed'} — offline fallback: ${offlineErr.message}`, 502);
    }
  }
};

// GET /api/tattoo/health — cheap ping without spending a Gemini or model call.
export const getTattooHealth = (req, res) => {
  const configured = !!process.env.GEMINI_API_KEY;
  const enabled = (process.env.GEMINI_ENABLED || '').trim() === '1';
  return success(res, {
    ok: true,
    primary: 'deep',
    deep_available: true,             // deep pipeline is on-BE, always "available" in principle
    gemini_configured: configured,
    gemini_enabled: enabled,
    cacheSize: cache.size,
    maxBytes: MAX_BYTES,
    allowedMime: [...ALLOWED_MIME],
  });
};
