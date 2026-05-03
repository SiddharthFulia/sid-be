import { GPU_WORKER_URL, GPU_WORKER_TOKEN } from '../../helpers/constants.js';

const TIMEOUT_MS = 5 * 60 * 1000;

export const WORKER_MODELS = {
  'ltx-video': 'LTX-Video',
  'wan-2.1': 'Wan2.1-T2V-1.3B',
  'wan-2.2': 'Wan2.2',
  'hunyuan': 'HunyuanVideo',
  'cogvideox': 'CogVideoX-2b',
  'mochi': 'Mochi-1',
};

export async function generateVideoWorker(prompt, opts = {}) {
  if (!GPU_WORKER_URL) {
    throw new Error('GPU worker not configured — set GPU_WORKER_URL in .env to your Lightning AI / Kaggle / Colab tunnel URL');
  }

  let pingOk = false;
  try {
    const ping = await fetch(`${GPU_WORKER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    pingOk = ping.ok;
  } catch {}
  if (!pingOk) {
    throw new Error(`GPU worker not reachable at ${GPU_WORKER_URL} — start the worker on your GPU notebook and refresh the tunnel URL`);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (GPU_WORKER_TOKEN) headers['Authorization'] = `Bearer ${GPU_WORKER_TOKEN}`;

  const res = await fetch(`${GPU_WORKER_URL}/generate-video`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      prompt,
      model: opts.model || 'ltx-video',
      duration: opts.duration || 5,
      aspect_ratio: opts.aspectRatio || '9:16',
      style: opts.style || 'cinematic',
      audio: opts.audio !== false,
      steps: opts.steps,
      cfg: opts.cfg,
    }),
  });

  if (!res.ok) {
    let msg = `GPU worker error: ${res.status}`;
    try {
      const err = await res.json();
      msg = err.detail || err.message || err.error || msg;
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  if (!data?.videoUrl) throw new Error('GPU worker returned no videoUrl');

  return {
    videoUrl: data.videoUrl,
    provider: 'worker',
    model: data.model || WORKER_MODELS[opts.model || 'ltx-video'] || opts.model,
    durationSec: data.durationSec,
    seed: data.seed,
  };
}
