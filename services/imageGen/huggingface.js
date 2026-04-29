import { HF_TOKEN } from '../../helpers/constants.js';

const HF_API = 'https://router.huggingface.co/hf-inference/models';

/**
 * Hugging Face Inference — FLUX.1-schnell. Free monthly credits per account.
 * Returns base64 data URL.
 */
export async function generateImage(prompt, model = 'black-forest-labs/FLUX.1-schnell') {
  if (!HF_TOKEN) throw new Error('Hugging Face token not configured');

  const res = await fetch(`${HF_API}/${model}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        seed: Math.floor(Math.random() * 2147483647),
        num_inference_steps: 4,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 503) throw new Error('Model is loading, try again in 30 seconds');
    if (res.status === 402) throw new Error('Hugging Face monthly credits depleted — try Together or Cloudflare');
    throw new Error(err.error || `HF API error: ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return {
    image: `data:image/png;base64,${base64}`,
    model,
    provider: 'huggingface',
  };
}
