// Text-to-3D mesh generation lane. Same shape as the chat lane:
//   1. FE POSTs prompt + model + steps → BE creates a mesh_jobs row
//      and publishes a trigger to QUEUE_MESH.
//   2. Worker pulls the row, runs the pipeline (e.g. Shap-E), uploads
//      the resulting GLB to Cloudinary, and posts the URL back via
//      /api/gpu-worker/mesh-complete.
//   3. FE polls /api/mesh/status/:jobId until status === 'completed'
//      and then renders the GLB inline via <model-viewer>.

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  createMeshJob, getMeshJob, listMeshJobs,
} from '../../services/aiVideo/meshStore.js';
import { publishMeshJob } from '../../services/aiVideo/messageQueue.js';

// Whitelist of accepted text-to-3D models. Locked down here so the FE
// can't sneak unknown engine slugs through to the worker.
//
//   shap-e     — OpenAI Shap-E. Pure text → 3D. Solid, ~30-60s, lower
//                fidelity. Uses only `steps`.
//   tripo      — Cloudflare Flux image → TripoSR. ~10-15s, higher
//                fidelity, image-conditioned. Uses only `steps`.
//   trellis    — Microsoft TRELLIS. Two-stage flow (sparse-structure +
//                structured-latent) → high-quality mesh + texture.
//                ~2-3m. Honours meshQuality / textureQuality /
//                textureResolution / polygonTarget + seed / guidance /
//                negativePrompt.
//   trellis-v2 — TRELLIS v2 with the larger SLAT decoder. Same params,
//                ~3-5m, finer mesh + cleaner texture seams.
//   hunyuan3d  — Tencent Hunyuan3D-2. DiT shape generator + texture
//                generator. ~4-6m. Honours the same quality params,
//                with `meshQuality` mapped to `octree_resolution`
//                (256 / 384 / 512) and `textureQuality` mapped to
//                `texture_steps`.
const VALID_MODELS = new Set([
  'shap-e', 'tripo', 'trellis', 'trellis-v2', 'hunyuan3d',
]);
const QUALITY_MODELS = new Set(['trellis', 'trellis-v2', 'hunyuan3d']);
// Engines that natively accept a reference image (image-to-3D pipeline).
// Shap-E is pure text; TripoSR auto-generates its own image via Flux so
// a user-supplied reference would conflict with its single-image step.
const IMAGE_CAPABLE_MODELS = new Set(['trellis', 'trellis-v2', 'hunyuan3d']);
const IMAGE_URL_MAX_CHARS = 600;

const PROMPT_MAX_CHARS = 600;
const STEPS_MIN = 16;
const STEPS_MAX = 64;
const STEPS_DEFAULT = 32;
// Quality knobs — accepted on every model but only QUALITY_MODELS forward
// them to the worker. Clamping happens server-side so the worker can trust
// the row contents.
const QUALITY_MIN = 0;
const QUALITY_MAX = 100;
const QUALITY_DEFAULT = 50;
const VALID_TEXTURE_RES = new Set([512, 1024, 2048]);
const POLYGON_MIN = 1000;
const POLYGON_MAX = 250000;
const GUIDANCE_MIN = 0;
const GUIDANCE_MAX = 30;
const NEGATIVE_MAX_CHARS = 400;

const clampInt = (raw, min, max, fallback) => {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};
const clampFloat = (raw, min, max, fallback) => {
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

// POST /api/mesh/generate
//   {
//     prompt: string,
//     model?: 'shap-e' | 'tripo' | 'trellis' | 'trellis-v2' | 'hunyuan3d',
//     steps?: int (16..64, default 32),
//     // Quality knobs — only honoured on trellis / trellis-v2 / hunyuan3d.
//     // Stored on every row so the FE round-trips the user's choice.
//     seed?: int,
//     guidance?: float (0..30),
//     negativePrompt?: string (≤ 400 chars),
//     meshQuality?: int (0..100, default 50),
//     textureQuality?: int (0..100, default 50),
//     textureResolution?: 512 | 1024 | 2048,
//     polygonTarget?: int (1000..250000),
//   }
export const postCreateMeshJob = (req, res) => {
  try {
    let {
      prompt,
      model = 'shap-e',
      steps = STEPS_DEFAULT,
      seed,
      guidance,
      negativePrompt,
      meshQuality,
      textureQuality,
      textureResolution,
      polygonTarget,
      imageUrl,
    } = req.body || {};

    // Validate prompt.
    if (typeof prompt !== 'string') return error(res, 'prompt is required', 400);
    prompt = prompt.trim();
    if (!prompt) return error(res, 'prompt is required', 400);
    if (prompt.length > PROMPT_MAX_CHARS) {
      return error(res, `prompt must be ≤ ${PROMPT_MAX_CHARS} characters`, 400);
    }

    // Validate model.
    if (typeof model !== 'string' || !VALID_MODELS.has(model)) {
      return error(res, `model must be one of: ${[...VALID_MODELS].join(', ')}`, 400);
    }

    // Clamp steps to [STEPS_MIN, STEPS_MAX].
    const safeSteps = clampInt(steps, STEPS_MIN, STEPS_MAX, STEPS_DEFAULT);

    // Clamp the advanced quality knobs. We store them on every row (so the
    // FE can round-trip the user's choice for the History view) but only
    // QUALITY_MODELS actually forward them to the worker pipeline.
    const safeSeed = seed != null && Number.isFinite(parseInt(seed, 10))
      ? clampInt(seed, 0, 0x7fffffff, null) : null;
    const safeGuidance = guidance != null
      ? clampFloat(guidance, GUIDANCE_MIN, GUIDANCE_MAX, null) : null;
    const safeNegative = typeof negativePrompt === 'string' && negativePrompt.trim()
      ? negativePrompt.trim().slice(0, NEGATIVE_MAX_CHARS) : null;
    const safeMeshQuality = meshQuality != null
      ? clampInt(meshQuality, QUALITY_MIN, QUALITY_MAX, QUALITY_DEFAULT) : null;
    const safeTextureQuality = textureQuality != null
      ? clampInt(textureQuality, QUALITY_MIN, QUALITY_MAX, QUALITY_DEFAULT) : null;
    const safeTextureRes = textureResolution != null
      && VALID_TEXTURE_RES.has(parseInt(textureResolution, 10))
      ? parseInt(textureResolution, 10) : null;
    const safePolygonTarget = polygonTarget != null
      ? clampInt(polygonTarget, POLYGON_MIN, POLYGON_MAX, null) : null;

    // Reference image — accepted only for the image-capable engines.
    // Must be a string URL starting with http(s):// to keep us from
    // accidentally storing data: blobs (too big) or local paths.
    let safeImageUrl = null;
    if (typeof imageUrl === 'string' && imageUrl.trim()) {
      const trimmed = imageUrl.trim();
      if (!IMAGE_CAPABLE_MODELS.has(model)) {
        return error(res, `imageUrl is only supported on: ${[...IMAGE_CAPABLE_MODELS].join(', ')}`, 400);
      }
      if (!/^https?:\/\//i.test(trimmed)) {
        return error(res, 'imageUrl must start with http:// or https://', 400);
      }
      if (trimmed.length > IMAGE_URL_MAX_CHARS) {
        return error(res, `imageUrl must be ≤ ${IMAGE_URL_MAX_CHARS} characters`, 400);
      }
      safeImageUrl = trimmed;
    }

    const job = createMeshJob({
      prompt, model, steps: safeSteps,
      seed: safeSeed,
      guidance: safeGuidance,
      negativePrompt: safeNegative,
      meshQuality: safeMeshQuality,
      textureQuality: safeTextureQuality,
      textureResolution: safeTextureRes,
      polygonTarget: safePolygonTarget,
      imageUrl: safeImageUrl,
    });
    publishMeshJob({ jobId: job.jobId, model }).catch(e =>
      logger.warn(`Mesh publish skipped: ${e.message}`));

    const qualityTag = QUALITY_MODELS.has(model)
      ? ` | mesh=${safeMeshQuality ?? '-'} tex=${safeTextureQuality ?? '-'} texRes=${safeTextureRes ?? '-'}`
      : '';
    const imageTag = safeImageUrl ? ' | img=Y' : '';
    logger.info(`MESH NEW | ${job.jobId} | model=${model} | steps=${safeSteps}${qualityTag}${imageTag} | prompt="${prompt.slice(0, 80)}"`);
    return success(res, {
      jobId: job.jobId,
      status: job.status,
      prompt: job.prompt,
      model: job.model,
    });
  } catch (err) {
    logger.error('Mesh create failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/mesh/status/:jobId — full row minus logs (those come via job-logs).
export const getMeshStatus = (req, res) => {
  const row = getMeshJob(req.params.jobId);
  if (!row) return error(res, 'Mesh job not found', 404);
  const { logs: _logs, ...rest } = row;
  return success(res, rest);
};

// GET /api/mesh/list?status=...&limit=...
export const listMeshJobsCtrl = (req, res) => {
  try {
    const status = typeof req.query.status === 'string' && req.query.status
      ? req.query.status
      : undefined;
    const limit = parseInt(req.query.limit, 10) || 24;
    const items = listMeshJobs({ status, limit });
    // Strip per-row `logs` to keep the list payload small.
    const slim = items.map(({ logs: _logs, ...rest }) => rest);
    return success(res, { items: slim, total: slim.length });
  } catch (err) {
    logger.error('Mesh list failed', err.message);
    return error(res, err.message);
  }
};
