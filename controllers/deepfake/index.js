// Deepfake lane controller. Vault-gated at the route level — every endpoint
// here sits behind requireVault, so the FE password is the gate, not just
// the UI hide.
//
// Two job kinds:
//   • 'face-swap' — sourceFaceDataUrl + targetImageDataUrl
//                    → swapped image (insightface inswapper_128.onnx on 5090)
//   • 'voice-any' — referenceAudioDataUrl + prompt (+ optional melody)
//                    → cloned-voice MP3. Same XTTS path as the public
//                      voice-clone lane, but no consent attestation gate.
//
// Worker dispatches by kind, posts back to /api/gpu-worker/deepfake-*.

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  createDeepfakeJob, getDeepfakeJob, listDeepfakeJobs, updateDeepfakeJob,
} from '../../services/aiVideo/deepfakeStore.js';
import {
  isCloudinaryConfigured,
  uploadSourceImage as cdnUploadImage,
  uploadAudioDataUrl as cdnUploadAudio,
} from '../../services/aiVideo/cloudinaryStore.js';
import { publishDeepfakeJob } from '../../services/aiVideo/messageQueue.js';

const VALID_KINDS = new Set(['face-swap', 'voice-any']);

const PROMPT_MAX_CHARS = 2000;

// POST /api/deepfake/generate (Vault-gated)
//   face-swap: { kind: 'face-swap', sourceFaceDataUrl, targetImageDataUrl }
//   voice-any: { kind: 'voice-any', referenceAudioDataUrl, prompt,
//                language?, melodyAudioDataUrl? }
export const postCreateDeepfakeJob = async (req, res) => {
  try {
    const {
      kind,
      sourceFaceDataUrl, targetImageDataUrl,
      referenceAudioDataUrl, melodyAudioDataUrl,
      prompt, language,
    } = req.body || {};

    if (!VALID_KINDS.has(kind)) {
      return error(res, "kind must be 'face-swap' | 'voice-any'", 400);
    }
    if (!isCloudinaryConfigured()) {
      return error(res, 'Cloudinary not configured', 503);
    }

    if (kind === 'face-swap') {
      if (!sourceFaceDataUrl)  return error(res, 'sourceFaceDataUrl is required',  400);
      if (!targetImageDataUrl) return error(res, 'targetImageDataUrl is required', 400);

      let srcUrl, tgtUrl;
      try {
        const upSrc = await cdnUploadImage(sourceFaceDataUrl);
        srcUrl = upSrc.url || upSrc.secure_url;
        const upTgt = await cdnUploadImage(targetImageDataUrl);
        tgtUrl = upTgt.url || upTgt.secure_url;
      } catch (e) {
        return error(res, `Could not upload images: ${e.message}`, 502);
      }
      const job = createDeepfakeJob({
        kind: 'face-swap',
        model: 'inswapper_128',
        sourceUrl: srcUrl,
        targetUrl: tgtUrl,
      });
      publishDeepfakeJob({ jobId: job.jobId, kind, model: 'inswapper_128' })
        .catch(e => logger.warn(`Deepfake publish skipped: ${e.message}`));

      logger.info(`DEEPFAKE QUEUE | ${job.jobId} | kind=face-swap`);
      return success(res, { jobId: job.jobId, status: job.status, kind: 'face-swap' });
    }

    if (kind === 'voice-any') {
      if (!referenceAudioDataUrl) {
        return error(res, 'referenceAudioDataUrl is required', 400);
      }
      const text = String(prompt || '').trim();
      if (text.length < 2)                    return error(res, 'prompt (text/lyrics) is required', 400);
      if (text.length > PROMPT_MAX_CHARS)     return error(res, `prompt too long (max ${PROMPT_MAX_CHARS} chars)`, 400);

      let refUrl, melodyUrl = null;
      try {
        const up = await cdnUploadAudio(referenceAudioDataUrl);
        refUrl = up.url || up.secure_url;
      } catch (e) {
        return error(res, `Could not upload reference clip: ${e.message}`, 502);
      }
      if (melodyAudioDataUrl) {
        try {
          const up = await cdnUploadAudio(melodyAudioDataUrl);
          melodyUrl = up.url || up.secure_url;
        } catch (e) {
          logger.warn(`Deepfake melody upload skipped (non-fatal): ${e.message}`);
        }
      }
      const vcModel = melodyUrl ? 'xtts-v2+rvc' : 'xtts-v2';
      const lang = typeof language === 'string' && language ? language : 'en';
      const job = createDeepfakeJob({
        kind: 'voice-any',
        model: vcModel,
        sourceUrl: refUrl,
        melodyUrl,
        prompt: text,
        language: lang,
      });
      publishDeepfakeJob({ jobId: job.jobId, kind, model: vcModel })
        .catch(e => logger.warn(`Deepfake publish skipped: ${e.message}`));

      logger.info(`DEEPFAKE QUEUE | ${job.jobId} | kind=voice-any | model=${vcModel}`);
      return success(res, { jobId: job.jobId, status: job.status, kind: 'voice-any', model: vcModel });
    }

    return error(res, 'Unhandled deepfake kind', 400);
  } catch (err) {
    logger.error('Deepfake submit failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/deepfake/status/:jobId (Vault-gated)
export const getDeepfakeStatus = (req, res) => {
  const row = getDeepfakeJob(req.params.jobId);
  if (!row) return error(res, 'Deepfake job not found', 404);
  return success(res, row);
};

// GET /api/deepfake/list?status=&kind=&page=&pageSize= (Vault-gated)
// Returns { items, total, page, pageSize, pages }. Server clamps
// pageSize to [1, 1000]. The previous `total: items.length` shape was
// a lie — page 2 would have reported the same wrong total as page 1.
export const listDeepfakeJobsCtrl = (req, res) => {
  try {
    const status = typeof req.query.status === 'string' && req.query.status && req.query.status !== 'all'
      ? req.query.status : undefined;
    const kind   = typeof req.query.kind   === 'string' && req.query.kind && req.query.kind !== 'all'
      ? req.query.kind   : undefined;
    const page     = parseInt(req.query.page, 10)     || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || parseInt(req.query.limit, 10) || 24;
    const result = listDeepfakeJobs({ status, kind, page, pageSize });
    return success(res, result);
  } catch (err) {
    logger.error('Deepfake list failed', err.message);
    return error(res, err.message);
  }
};
