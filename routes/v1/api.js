import { Router } from 'express';
import { getHealth, getStats } from '../../controllers/v1/health.js';
import {
  postChat, postAI, postGroqChat, postGeminiChat, postGeminiVision, postPromptCoach,
  postChatLocal, getChatStatus, getLocalModels,
  postCreateConversation, getListConversations, getOneConversation,
  patchConversation, deleteOneConversation, postConversationsBulk, postSendMessage,
  postCompactConversation, postCompactFinalize,
} from '../../controllers/v1/ai.js';
import { postFaceAnalyze, postObjectDetect, getFaceHealth } from '../../controllers/v1/face.js';
import { postExport } from '../../controllers/v1/export.js';
import { getNasa } from '../../controllers/v1/nasa.js';
import { postImageGen, postImageEdit, postTTS, postSummarize } from '../../controllers/v1/hf.js';
import { postGenerateVideo, getJobStatus, getTodayVideo, getVideoList, getVideoProviders, deleteVideoById, postUploadSourceImage, getJobQueue, getFailuresList, getJobsFeed, postImageEnhance, postMusicGenerate, postSpeechToText, getImageStatus, getImageList, deleteImage as deleteImageById, postImageBulkAction, postVideoBulkAction } from '../../controllers/v1/aiVideo.js';
import { postRegister, getNextJob, postJobComplete, postJobFailed, postJobProgress, postImageComplete, postImageFailed, postImageProgress, postLipsyncProgress, postLipsyncComplete, postLipsyncFailed, postAudioProgress, postAudioComplete, postAudioFailed, postChatJob, postChatProgress, postChatComplete, postChatFailed, postMeshJob, postMeshProgress, postMeshComplete, postMeshFailed, postDeepfakeJob, postDeepfakeProgress, postDeepfakeComplete, postDeepfakeFailed } from '../../controllers/v1/gpuWorker.js';
import { postCreateMeshJob, getMeshStatus, listMeshJobsCtrl } from '../../controllers/v1/mesh.js';
import { postCreateDeepfakeJob, getDeepfakeStatus, listDeepfakeJobsCtrl } from '../../controllers/v1/deepfake.js';
import { getPlayers, postPlayer, getPlayer, postScore, getScores } from '../../controllers/v1/games.js';
import { postBestMove as postChessBestMove, postAnalyze as postChessAnalyze, postPlay as postChessPlay, getStatus as getChessStatus, postSaveGame, getGames as getChessGames, getOneGame as getChessGame, patchGame as patchChessGame, removeGame as removeChessGame, postBulkSaveGames as postChessBulkSave, getCollections as getChessCollections, postCreateMatch, postJoinMatch, getMatchState, postMatchMove, postResignMatch, listLiveMatches } from '../../controllers/v1/chess.js';
import { getServerStats, getDbStats, getQueueStats, getWorkers, postPurgeQueue, getActivityTimeseries } from '../../controllers/v1/admin.js';
import {
  postLipsync, getLipsyncStatus, getLipsyncList, deleteLipsync, postLipsyncBulkAction,
  postAudio, getAudioStatus, getAudioList, deleteAudio, postAudioBulkAction,
  postCinema, getCinemaStatus, getCinemaList, deleteCinema, patchCinemaShots, postCinemaBulkAction,
} from '../../controllers/v1/studio.js';
import { checkVaultPassword, signVaultToken, requireVault, maybeVault } from '../../services/auth/vault.js';
import { listLogs } from '../../services/aiVideo/logStore.js';
import { success, error } from '../../helpers/res_helper.js';

const router = Router();

// Health
router.get('/health', getHealth);
router.get('/stats', getStats);

// AI (Ollama local — on Oracle BE)
router.post('/chat', postChat);
router.post('/ai', postAI);

// AI Chat 5090 lane — Ollama running on the home RTX 5090
router.post('/chat/local',                   postChatLocal);          // legacy single-shot
router.get('/chat/status/:jobId',            getChatStatus);
router.get('/chat/local-models',             getLocalModels);
// Conversation-aware multi-turn chat with persistence
router.post('/chat/conversations',           postCreateConversation);
router.get('/chat/conversations',            getListConversations);
router.post('/chat/conversations/bulk',      postConversationsBulk);
router.get('/chat/conversations/:chatId',    getOneConversation);
router.patch('/chat/conversations/:chatId',  patchConversation);
router.delete('/chat/conversations/:chatId', deleteOneConversation);
router.post('/chat/conversations/:chatId/messages', postSendMessage);
router.post('/chat/conversations/:chatId/compact',          postCompactConversation);
router.post('/chat/conversations/:chatId/compact/finalize', postCompactFinalize);

// Mesh generation (text → 3D on the 5090, e.g. Shap-E). Mirrors the
// chat-job lane: FE POSTs prompt + model + steps, worker pulls + runs +
// uploads the GLB, FE polls /status/:jobId until completed.
router.post('/mesh/generate',         postCreateMeshJob);
router.get( '/mesh/status/:jobId',    getMeshStatus);
router.get( '/mesh/list',             listMeshJobsCtrl);

// Deepfake lane (face-swap + voice-clone-of-anyone). Every public-facing
// endpoint sits behind requireVault — only the password-holder can submit,
// read job status, or list outputs. The worker-facing callback routes
// below use the shared worker token, same as the other gpu-worker/* routes.
router.post('/deepfake/generate',      requireVault, postCreateDeepfakeJob);
router.get( '/deepfake/status/:jobId', requireVault, getDeepfakeStatus);
router.get( '/deepfake/list',          requireVault, listDeepfakeJobsCtrl);

// Vault-gated admin dashboard
router.get( '/admin/server-stats', requireVault, getServerStats);
router.get( '/admin/db-stats',     requireVault, getDbStats);
router.get( '/admin/queues',       requireVault, getQueueStats);
router.get( '/admin/workers',      requireVault, getWorkers);
router.get( '/admin/activity',     requireVault, getActivityTimeseries);
router.post('/admin/queues/purge', requireVault, postPurgeQueue);

// Runner game — hand-gesture endless runner. Public; no auth (single-game
// portfolio toy). Player registry is case-insensitive upsert, score
// submissions validate ranges + difficulty whitelist.
// Chess analysis lane (Stockfish via node-uci). Public; depth/thinkMs
// clamped server-side so a misbehaving client can't pin the worker.
router.post('/chess/best-move', postChessBestMove);
router.post('/chess/analyze',   postChessAnalyze);
router.post('/chess/play',      postChessPlay);
router.get( '/chess/status',    getChessStatus);
// Saved games library
router.post(  '/chess/games',       postSaveGame);
router.get(   '/chess/games',       getChessGames);
router.get(   '/chess/games/:id',   getChessGame);
router.patch( '/chess/games/:id',   patchChessGame);
router.post('/chess/games/bulk',  postChessBulkSave);
router.get( '/chess/collections', getChessCollections);
router.delete('/chess/games/:id',   removeChessGame);
// Live online challenge matches — short-lived two-player lane
router.post(  '/chess/matches',             postCreateMatch);
router.post(  '/chess/matches/:id/join',    postJoinMatch);
router.get(   '/chess/matches/:id',         getMatchState);
router.post(  '/chess/matches/:id/move',    postMatchMove);
router.post(  '/chess/matches/:id/resign',  postResignMatch);
// Live lobby — one-shot listing of waiting matches. Deeper path than
// /chess/matches/:id so Express won't route-match it under :id.
router.get(   '/chess/matches/lobby/live',  listLiveMatches);

router.get( '/games/players',           getPlayers);
router.post('/games/players',           postPlayer);
router.get( '/games/players/:idOrName', getPlayer);
router.post('/games/scores',            postScore);
router.get( '/games/scores',            getScores);

// AI (Groq cloud — fast inference)
router.post('/groq', postGroqChat);

// AI (Gemini — Google, multimodal)
router.post('/gemini', postGeminiChat);
router.post('/gemini/vision', postGeminiVision);

// Prompt coach — turns a plain-English idea into a model-tuned image prompt.
// Used by the Image Studio "💡 Help me write a prompt" modal. The family field
// drives which system prompt is used (sdxl / pony / sdxl-hyper / flux).
router.post('/ai/prompt-coach', postPromptCoach);

// AI Tools (image gen, edit, TTS, summarize)
router.post('/generate-image', postImageGen);
router.post('/image-edit', postImageEdit);
router.post('/tts', postTTS);
router.post('/summarize', postSummarize);

// Vault login — returns a JWT used to access the create/delete endpoints.
// View/list endpoints stay public so the library is still readable to
// anyone with the link. Only mutating routes are protected.
router.post('/auth/vault-login', (req, res) => {
  const { password } = req.body || {};
  if (!checkVaultPassword(password)) {
    return error(res, 'Invalid password', 401);
  }
  return success(res, { token: signVaultToken() });
});
router.get('/auth/vault-status', requireVault, (_req, res) => success(res, { ok: true }));

// ─── Unified log feed (added 2026-05) ──────────────────────────────
// Lightweight live-tail endpoint. The FE polls this every 1.5s during a job
// passing `since=<lastTs>` so each response is just the new lines — much
// cheaper than re-fetching the whole status row.
//
//   GET /api/job-logs/:lane/:jobId?since=<ms>&limit=80
//
// Lanes: 'video' | 'image' | 'lipsync' | 'audio' | 'mesh' | 'deepfake'.
// Returns: { logs: [{ts, msg}, ...], nextSince } in chronological order.
// The deepfake lane is Vault-gated upstream (creates only reach here from
// requireVault routes); reading logs piggybacks on maybeVault and is OK
// to leave open — exposed logs only show step labels, never image bytes.
router.get('/job-logs/:lane/:jobId', maybeVault, (req, res) => {
  const lane = String(req.params.lane || '').toLowerCase();
  const jobId = req.params.jobId;
  if (!['video', 'image', 'lipsync', 'audio', 'mesh', 'deepfake'].includes(lane)) {
    return error(res, "lane must be 'video' | 'image' | 'lipsync' | 'audio' | 'mesh' | 'deepfake'", 400);
  }
  if (!jobId) return error(res, 'jobId required', 400);
  const sinceTs = parseInt(req.query.since, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 80, 500);
  const logs = listLogs({ jobId, lane, sinceTs, limit });
  return success(res, { logs, nextSince: logs.length ? logs[logs.length - 1].ts : sinceTs });
});

// AI Video — fully public CRUD. maybeVault sets req.vault on every request
// when a valid token is present; controllers use it to:
//   • return vault items in list/status when ?visibility=vault is requested
//   • allow `vault: true` flag on /generate (otherwise the flag is ignored)
// Routes themselves are NEVER blocked by auth — visitors can browse + create
// + delete public content without logging in. Auth only unlocks the private
// vault lane.
router.get('/ai-video/status/:jobId',   maybeVault, getJobStatus);
router.get('/ai-video/today',           getTodayVideo);
router.get('/ai-video/list',            maybeVault, getVideoList);
router.get('/ai-video/queue',           maybeVault, getJobQueue);
router.get('/ai-video/failures',        maybeVault, getFailuresList);
router.get('/ai-video/jobs',            maybeVault, getJobsFeed);
router.get('/ai-video/providers',       getVideoProviders);
router.post('/ai-video/generate',       maybeVault, postGenerateVideo);
router.delete('/ai-video/:videoId',     maybeVault, deleteVideoById);
router.post('/ai-video/upload-image',   maybeVault, postUploadSourceImage);
// Bulk actions — move-to-vault / make-public require auth; delete does not.
// requireVault sits inside the controller via the action discriminator, so
// the route uses maybeVault and the controller rejects unauthenticated
// move/public calls (defensive check below).
router.post('/ai-video/bulk',           maybeVault, (req, res, next) => {
  const a = req.body?.action;
  if ((a === 'move-to-vault' || a === 'make-public') && !req.vault) {
    return res.status(401).json({ status: false, message: 'Vault login required for this action' });
  }
  return postVideoBulkAction(req, res, next);
});

// Image Studio — same pattern
router.get('/image-enhance/status/:imageId',  maybeVault, getImageStatus);
router.get('/image-enhance/list',             maybeVault, getImageList);
router.post('/image-enhance',                 maybeVault, postImageEnhance);
router.delete('/image-enhance/:imageId',      maybeVault, deleteImageById);
router.post('/image-enhance/bulk',            maybeVault, (req, res, next) => {
  const a = req.body?.action;
  if ((a === 'move-to-vault' || a === 'make-public') && !req.vault) {
    return res.status(401).json({ status: false, message: 'Vault login required for this action' });
  }
  return postImageBulkAction(req, res, next);
});

// Music — public, no auth needed
router.post('/music/generate',                postMusicGenerate);

// Speech-to-Text — public, no auth needed. POST audio dataUrl, get transcript.
router.post('/stt',                           postSpeechToText);

// Structured-output exporter — accepts JSON/CSV/MD/XLSX/PDF and returns
// a downloadable file. Used by AI Chat to let users save model output
// in whichever format is most useful for them.
router.post('/export',                        postExport);

// GPU worker — polling client endpoints (called by Lightning AI worker)
router.post('/gpu-worker/register', postRegister);
router.get('/gpu-worker/next-job', getNextJob);
router.post('/gpu-worker/job-complete', postJobComplete);
router.post('/gpu-worker/job-failed', postJobFailed);
router.post('/gpu-worker/job-progress', postJobProgress);
router.post('/gpu-worker/image-progress', postImageProgress);
router.post('/gpu-worker/image-complete', postImageComplete);
router.post('/gpu-worker/image-failed',   postImageFailed);
// Lip Sync worker callbacks
router.post('/gpu-worker/lipsync-progress', postLipsyncProgress);
router.post('/gpu-worker/lipsync-complete', postLipsyncComplete);
router.post('/gpu-worker/lipsync-failed',   postLipsyncFailed);
// Audio Studio worker callbacks
router.post('/gpu-worker/audio-progress',   postAudioProgress);
router.post('/gpu-worker/audio-complete',   postAudioComplete);
router.post('/gpu-worker/audio-failed',     postAudioFailed);
// AI Chat worker callbacks (Ollama on 5090). Worker GETs the full job row
// when it pulls from the chat queue, then streams progress + final reply.
router.get( '/gpu-worker/chat-job/:jobId',  postChatJob);
router.post('/gpu-worker/chat-progress',    postChatProgress);
router.post('/gpu-worker/chat-complete',    postChatComplete);
router.post('/gpu-worker/chat-failed',      postChatFailed);
// Mesh worker callbacks (text→3D on 5090). Same pattern as the chat lane.
router.get( '/gpu-worker/mesh-job/:jobId',  postMeshJob);
router.post('/gpu-worker/mesh-progress',    postMeshProgress);
router.post('/gpu-worker/mesh-complete',    postMeshComplete);
router.post('/gpu-worker/mesh-failed',      postMeshFailed);

// Deepfake worker callbacks (Vault-gated lane). Same shape as mesh.
router.get( '/gpu-worker/deepfake-job/:jobId', postDeepfakeJob);
router.post('/gpu-worker/deepfake-progress',   postDeepfakeProgress);
router.post('/gpu-worker/deepfake-complete',   postDeepfakeComplete);
router.post('/gpu-worker/deepfake-failed',     postDeepfakeFailed);

// ─── Studio lanes (Tier 3) — no vault gating; library + bulk delete ─
// These lanes don't need NSFW gating — they live in their own libraries.
// `maybeVault` middleware stays so we still record auth state for telemetry,
// but the controllers ignore req.vault for visibility decisions.
router.post('/lipsync',                     maybeVault, postLipsync);
router.get('/lipsync/status/:jobId',        maybeVault, getLipsyncStatus);
router.get('/lipsync/list',                 maybeVault, getLipsyncList);
router.delete('/lipsync/:jobId',            maybeVault, deleteLipsync);
router.post('/lipsync/bulk',                maybeVault, postLipsyncBulkAction);

router.post('/audio',                       maybeVault, postAudio);
router.get('/audio/status/:jobId',          maybeVault, getAudioStatus);
router.get('/audio/list',                   maybeVault, getAudioList);
router.delete('/audio/:jobId',              maybeVault, deleteAudio);
router.post('/audio/bulk',                  maybeVault, postAudioBulkAction);

router.post('/cinema',                      maybeVault, postCinema);
router.get('/cinema/status/:projectId',     maybeVault, getCinemaStatus);
router.get('/cinema/list',                  maybeVault, getCinemaList);
router.delete('/cinema/:projectId',         maybeVault, deleteCinema);
router.patch('/cinema/:projectId',          maybeVault, patchCinemaShots);
router.post('/cinema/bulk',                 maybeVault, postCinemaBulkAction);

// Face Detection
router.post('/face-analyze', postFaceAnalyze);
router.post('/detect-objects', postObjectDetect);
router.get('/face-health', getFaceHealth);

// NASA API Proxy (offloads API key from frontend)
// Express 5 wildcard syntax: matches /nasa/planetary/apod, etc.
router.get('/nasa/{*endpoint}', getNasa);

// Generic third-party API proxy (pokemon, rickmorty, dogs, weather, etc.)
router.get('/proxy/{*endpoint}', getNasa);

export default router;
