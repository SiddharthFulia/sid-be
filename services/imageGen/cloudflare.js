import { CF_ACCOUNT_ID, CF_API_TOKEN } from '../../helpers/constants.js';

/**
 * Cloudflare Workers AI — FLUX.1-schnell. Free tier: ~10k neurons/day.
 * Returns base64 data URL.
 */
export async function generateImage(prompt, model = '@cf/black-forest-labs/flux-1-schnell') {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error('Cloudflare Workers AI not configured (CF_ACCOUNT_ID + CF_API_TOKEN required)');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      steps: 4,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('Cloudflare daily limit reached');
    if (res.status === 401 || res.status === 403) throw new Error('Cloudflare auth failed — check CF_API_TOKEN');
    const msg = err.errors?.[0]?.message || err.message || `Cloudflare error: ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();
  // CF returns { result: { image: "<base64>" }, success: true }
  const b64 = data?.result?.image;
  if (!b64) throw new Error('Cloudflare returned no image data');

  return {
    image: `data:image/jpeg;base64,${b64}`,
    model,
    provider: 'cloudflare',
  };
}
