// /tools/* group — single-purpose endpoints that don't deserve their
// own folder. Each handler lives in its existing controller; we just
// gather them here so the route file stays readable.
//
//   /generate-image · /image-edit · /tts · /summarize  → controllers/hf.js
//   /music/generate · /stt                              → controllers/aiVideo.js
//   /export                                             → controllers/export.js
//   /job-logs/:lane/:jobId                              → inline

import { Router } from 'express';
import { postImageGen, postImageEdit, postTTS, postSummarize } from '../../controllers/hf/index.js';
import { postMusicGenerate, postSpeechToText } from '../../controllers/aiVideo/index.js';
import { postExport } from '../../controllers/export/index.js';
import { maybeVault } from '../../services/auth/vault.js';
import { listLogs } from '../../services/aiVideo/logStore.js';
import { success, error } from '../../helpers/res_helper.js';

const router = Router();

// HF / Cloudflare image + text helpers
router.post('/generate-image', postImageGen);
router.post('/image-edit',     postImageEdit);
router.post('/tts',            postTTS);
router.post('/summarize',      postSummarize);

// Music + speech-to-text — public, no auth needed
router.post('/music/generate', postMusicGenerate);
router.post('/stt',            postSpeechToText);

// Structured-output exporter (json/csv/md/xlsx/pdf)
router.post('/export', postExport);

// Unified log feed — FE polls during a job with ?since=<ms> for cheap
// incremental updates. Lanes: 'video' | 'image' | 'lipsync' | 'audio'
// | 'mesh' | 'deepfake'. Deepfake is Vault-gated upstream on creates;
// reads piggyback on maybeVault so step labels are visible to anyone.
router.get('/job-logs/:lane/:jobId', maybeVault, (req, res) => {
  const lane = String(req.params.lane || '').toLowerCase();
  const jobId = req.params.jobId;
  if (!['video', 'image', 'lipsync', 'audio', 'mesh', 'deepfake', 'combine'].includes(lane)) {
    return error(res, "lane must be 'video' | 'image' | 'lipsync' | 'audio' | 'mesh' | 'deepfake' | 'combine'", 400);
  }
  if (!jobId) return error(res, 'jobId required', 400);
  const sinceTs = parseInt(req.query.since, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 80, 500);
  const logs = listLogs({ jobId, lane, sinceTs, limit });
  return success(res, { logs, nextSince: logs.length ? logs[logs.length - 1].ts : sinceTs });
});

export default router;
