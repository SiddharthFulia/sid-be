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
// shap-e   — pure text→3D (OpenAI Shap-E). Solid, ~30-60s, lower fidelity.
// tripo    — text → Cloudflare Flux image → TripoSR. Higher fidelity,
//            faster total (~10-15s) but quality depends on the
//            intermediate image. Best for recognisable objects.
const VALID_MODELS = new Set(['shap-e', 'tripo']);

const PROMPT_MAX_CHARS = 600;
const STEPS_MIN = 16;
const STEPS_MAX = 64;
const STEPS_DEFAULT = 32;

// POST /api/mesh/generate
//   { prompt: string, model?: 'shap-e', steps?: int (16..64, default 32) }
export const postCreateMeshJob = (req, res) => {
  try {
    let { prompt, model = 'shap-e', steps = STEPS_DEFAULT } = req.body || {};

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

    // Clamp steps to [STEPS_MIN, STEPS_MAX]. Non-integers fall back to default.
    const stepsInt = parseInt(steps, 10);
    const safeSteps = Number.isFinite(stepsInt)
      ? Math.min(Math.max(stepsInt, STEPS_MIN), STEPS_MAX)
      : STEPS_DEFAULT;

    const job = createMeshJob({ prompt, model, steps: safeSteps });
    publishMeshJob({ jobId: job.jobId, model }).catch(e =>
      logger.warn(`Mesh publish skipped: ${e.message}`));

    logger.info(`MESH NEW | ${job.jobId} | model=${model} | steps=${safeSteps} | prompt="${prompt.slice(0, 80)}"`);
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
