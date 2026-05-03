import { HF_TOKEN } from '../../helpers/constants.js';

const HF_INFERENCE = 'https://api-inference.huggingface.co/models';

export const HF_MODELS = {
  'ltx-video': 'Lightricks/LTX-Video',
  'wan-2.1': 'Wan-AI/Wan2.1-T2V-1.3B',
  'zeroscope': 'cerspense/zeroscope_v2_576w',
  'cogvideox-2b': 'THUDM/CogVideoX-2b',
};

export async function generateVideoHF(prompt, opts = {}) {
  if (!HF_TOKEN) throw new Error('Hugging Face token not configured (set HF_TOKEN)');

  const modelKey = (opts.model || 'ltx-video').toLowerCase();
  const modelId = HF_MODELS[modelKey] || opts.model || HF_MODELS['ltx-video'];

  const body = {
    inputs: prompt,
    parameters: {
      num_frames: opts.duration ? Math.min(opts.duration * 24, 240) : 48,
      ...(opts.aspectRatio === '9:16' ? { width: 384, height: 672 } : { width: 672, height: 384 }),
    },
  };

  const res = await fetch(`${HF_INFERENCE}/${modelId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'video/mp4, application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = `HF inference failed: ${res.status}`;
    try {
      const err = await res.json();
      msg = err.error || err.message || msg;
    } catch {}
    if (res.status === 503) throw new Error('Model is loading on HF — try again in 30-60 seconds');
    if (res.status === 402 || res.status === 429) throw new Error(`HF rate limit hit — ${msg}`);
    if (res.status === 404) {
      throw new Error(
        `Hugging Face's free Inference API does not host video models. ` +
        `Switch the provider to "GPU Worker" — start ComfyUI on a free GPU notebook ` +
        `(Lightning AI / Kaggle / Colab), tunnel it, and set GPU_WORKER_URL in sid-be/.env. ` +
        `See /gpu-worker/README.md for the 5-minute setup.`
      );
    }
    throw new Error(msg);
  }

  const ct = res.headers.get('content-type') || '';

  if (ct.startsWith('video/') || ct.startsWith('application/octet-stream')) {
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), provider: 'huggingface', model: modelId };
  }

  if (ct.includes('application/json')) {
    const json = await res.json();
    if (json.url) {
      const v = await fetch(json.url);
      const ab = await v.arrayBuffer();
      return { buffer: Buffer.from(ab), provider: 'huggingface', model: modelId };
    }
    throw new Error(json.error || 'HF returned JSON without video URL');
  }

  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), provider: 'huggingface', model: modelId };
}
