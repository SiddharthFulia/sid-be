// Standalone music generation via Hugging Face Inference API.
// No GPU needed on the BE — HF runs the model server-side.
// Free tier: rate-limited (~30 req/min) but plenty for individual use.
//
// Set HF_API_KEY in .env to bypass rate limits + cold-start delays:
//   https://huggingface.co/settings/tokens (Read access is enough)
//
// Without a key the call still works but you'll see 503 "model loading" the
// first time the model warms up — we retry once after a 20s sleep.

import { uploadAudioBuffer } from './cloudinaryStore.js';
import logger from '../../helpers/logger.js';

// Accept either HF_TOKEN (the canonical Hugging Face name) or HF_API_KEY for
// back-compat. The repo's existing `.env` uses HF_TOKEN.
const HF_API_KEY = process.env.HF_TOKEN || process.env.HF_API_KEY || '';
const HF_BASE = 'https://api-inference.huggingface.co/models';
// MusicGen-large gives the best output but warms up slowly. Override via env
// if you'd rather use musicgen-medium (~2× faster cold start).
const HF_MODEL = process.env.HF_MUSIC_MODEL || 'facebook/musicgen-small';

/**
 * Generate music. Returns { audioUrl, mime, durationSec, model }.
 * Throws on permanent errors. Caller is responsible for cropping the
 * returned audio to a target duration if needed (HF doesn't accept a
 * duration parameter — it always returns ~15s for musicgen-small).
 */
export async function generateMusicViaHF({ prompt, duration = 8 }) {
  if (!prompt || typeof prompt !== 'string' || prompt.length < 3) {
    throw new Error('Music prompt is required');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (HF_API_KEY) headers.Authorization = `Bearer ${HF_API_KEY}`;

  const url = `${HF_BASE}/${HF_MODEL}`;
  const body = JSON.stringify({
    inputs: prompt,
    parameters: { duration: Math.min(Math.max(duration, 3), 30) },
  });

  // First attempt
  let res = await fetch(url, { method: 'POST', headers, body });

  // Cold start: HF returns 503 with `estimated_time` when the model is
  // loading. Sleep that long, retry once.
  if (res.status === 503) {
    const info = await res.json().catch(() => ({}));
    const wait = Math.min((info.estimated_time || 20) * 1000, 30000);
    logger.warn(`HF MusicGen warming up — retrying in ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    res = await fetch(url, { method: 'POST', headers, body });
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HF MusicGen ${res.status}: ${txt.slice(0, 240)}`);
  }

  const contentType = res.headers.get('content-type') || 'audio/mpeg';
  const buf = Buffer.from(await res.arrayBuffer());

  // Stream into Cloudinary so the FE gets a permanent URL it can stream/loop.
  const upload = await uploadAudioBuffer(buf, contentType);
  return {
    audioUrl: upload.url,
    publicId: upload.publicId,
    mime: contentType,
    bytes: buf.length,
    model: HF_MODEL,
    provider: 'hf',
  };
}
