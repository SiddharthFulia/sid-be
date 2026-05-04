import { generateVideoWorker, WORKER_MODELS } from './gpuWorker.js';
import { generateZskyVideo, ZSKY_MODELS } from './zsky.js';

export const VIDEO_PROVIDERS = ['auto', 'zsky', 'comfyui'];

export const VIDEO_MODELS_BY_PROVIDER = {
  auto: ['auto'],
  zsky: Object.keys(ZSKY_MODELS),
  comfyui: Object.keys(WORKER_MODELS),
};

const AUTO_FALLBACK_ORDER = ['zsky', 'comfyui'];

async function dispatchSingle(providerName, prompt, opts) {
  switch (providerName) {
    case 'zsky':
      return generateZskyVideo(prompt, opts);
    case 'comfyui':
    case 'worker':
    case 'gpu':
      return generateVideoWorker(prompt, opts);
    default:
      throw new Error(`Unknown video provider: ${providerName}`);
  }
}

export async function generateVideo(prompt, opts = {}) {
  const provider = (opts.provider || 'auto').toLowerCase();

  if (provider !== 'auto') {
    const result = await dispatchSingle(provider, prompt, opts);
    return { ...result, providerUsed: result.provider || provider };
  }

  const errors = [];
  for (const p of AUTO_FALLBACK_ORDER) {
    try {
      const result = await dispatchSingle(p, prompt, opts);
      return { ...result, providerUsed: result.provider || p, attempted: errors };
    } catch (err) {
      if (err.contentPolicy) {
        const policyErr = new Error(err.message);
        policyErr.contentPolicy = true;
        throw policyErr;
      }
      errors.push({ provider: p, error: err.message });
    }
  }

  const summary = errors.map(e => `${e.provider}: ${e.error}`).join(' | ');
  throw new Error(`All video providers failed — ${summary}`);
}
