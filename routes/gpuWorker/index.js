// /gpu-worker/* — polling client endpoints called by the Lightning AI
// (and home-5090) worker. Auth via the shared worker token; controllers
// check it themselves.

import { Router } from 'express';
import {
  postRegister, getNextJob, postJobComplete, postJobFailed, postJobProgress,
  postImageComplete, postImageFailed, postImageProgress,
  postLipsyncProgress, postLipsyncComplete, postLipsyncFailed,
  postAudioProgress, postAudioComplete, postAudioFailed,
  postChatJob, postChatProgress, postChatComplete, postChatFailed,
  postMeshJob, postMeshProgress, postMeshComplete, postMeshFailed,
  postDeepfakeJob, postDeepfakeProgress, postDeepfakeComplete, postDeepfakeFailed,
  postYtJob, postYtProgress, postYtComplete, postYtFailed,
} from '../../controllers/gpuWorker/index.js';

const router = Router();

router.post('/gpu-worker/register',         postRegister);
router.get( '/gpu-worker/next-job',         getNextJob);
router.post('/gpu-worker/job-complete',     postJobComplete);
router.post('/gpu-worker/job-failed',       postJobFailed);
router.post('/gpu-worker/job-progress',     postJobProgress);

// Image enhancer worker callbacks
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

// AI Chat worker callbacks (Ollama on 5090).
router.get( '/gpu-worker/chat-job/:jobId',  postChatJob);
router.post('/gpu-worker/chat-progress',    postChatProgress);
router.post('/gpu-worker/chat-complete',    postChatComplete);
router.post('/gpu-worker/chat-failed',      postChatFailed);

// Mesh worker callbacks (text → 3D on 5090).
router.get( '/gpu-worker/mesh-job/:jobId',  postMeshJob);
router.post('/gpu-worker/mesh-progress',    postMeshProgress);
router.post('/gpu-worker/mesh-complete',    postMeshComplete);
router.post('/gpu-worker/mesh-failed',      postMeshFailed);

// Deepfake worker callbacks (Vault-gated lane).
router.get( '/gpu-worker/deepfake-job/:jobId', postDeepfakeJob);
router.post('/gpu-worker/deepfake-progress',   postDeepfakeProgress);
router.post('/gpu-worker/deepfake-complete',   postDeepfakeComplete);
router.post('/gpu-worker/deepfake-failed',     postDeepfakeFailed);

// YouTube downloader 5090 worker callbacks. /yt-complete/:jobId takes
// a multipart upload — multer is wrapped inside the controller export
// itself, no additional middleware needed at the route layer.
router.get( '/gpu-worker/yt-job/:jobId',       postYtJob);
router.post('/gpu-worker/yt-progress',         postYtProgress);
router.post('/gpu-worker/yt-complete/:jobId',  postYtComplete);
router.post('/gpu-worker/yt-failed',           postYtFailed);

export default router;
