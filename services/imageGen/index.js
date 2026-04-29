import { generateImage as hfGenerate } from './huggingface.js';
import { generateImage as cfGenerate } from './cloudflare.js';

export const PROVIDERS = ['cloudflare', 'huggingface'];

/**
 * Dispatch image generation to the requested provider.
 * @param {string} prompt
 * @param {object} opts - { provider, model }
 */
export async function generateImage(prompt, opts = {}) {
  const provider = (opts.provider || 'cloudflare').toLowerCase();

  switch (provider) {
    case 'cloudflare':
    case 'cf':
      return cfGenerate(prompt, opts.model);
    case 'huggingface':
    case 'hf':
      return hfGenerate(prompt, opts.model);
    default:
      throw new Error(`Unknown image provider: ${provider}`);
  }
}
