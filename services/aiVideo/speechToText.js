// Speech-to-Text via Hugging Face Inference (Whisper).
// No GPU on the BE — HF runs the model server-side. Set HF_TOKEN in .env;
// without it many models 401 / 404 because they're gated.
//
// Tries both Inference endpoints because HF has been migrating models:
//   1. router.huggingface.co/hf-inference/models/…   (current "router")
//   2. api-inference.huggingface.co/models/…         (legacy)
// Whichever responds 200 wins; if both fail we propagate the most
// informative error to the FE.

import logger from '../../helpers/logger.js';

const HF_API_KEY = process.env.HF_TOKEN || process.env.HF_API_KEY || '';
// Whisper large-v3 is the most accurate; distil-whisper-large-v3 is ~2x
// faster with slightly less accuracy if you want to flip via env.
const HF_MODEL = process.env.HF_STT_MODEL || 'openai/whisper-large-v3';

const ENDPOINTS = [
  // Router first — Whisper-large-v3 lives behind the new router only.
  (model) => `https://router.huggingface.co/hf-inference/models/${model}`,
  (model) => `https://api-inference.huggingface.co/models/${model}`,
];

// Whisper / HF ASR backends are picky about Content-Type. Browser
// MediaRecorder labels the data as `audio/webm;codecs=opus` — many of
// HF's serverless ASR servers reject the `;codecs=…` suffix outright
// and return 415. Strip the parameter so HF only sees the base MIME.
function _normalizeMime(mime) {
  if (!mime) return 'audio/mpeg';
  const base = String(mime).split(';')[0].trim().toLowerCase() || 'audio/mpeg';
  return base;
}

async function _callOnce({ url, buf, mime, language }) {
  const headers = { 'Content-Type': mime };
  if (HF_API_KEY) headers.Authorization = `Bearer ${HF_API_KEY}`;

  const params = new URLSearchParams();
  if (language) params.set('language', language);
  params.set('return_timestamps', 'true');
  const full = params.toString() ? `${url}?${params}` : url;

  let res = await fetch(full, { method: 'POST', headers, body: buf });

  // Cold start: HF returns 503 with estimated_time. Retry once.
  if (res.status === 503) {
    const info = await res.json().catch(() => ({}));
    const wait = Math.min((info.estimated_time || 20) * 1000, 30000);
    logger.warn(`HF Whisper warming up — retrying in ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    res = await fetch(full, { method: 'POST', headers, body: buf });
  }

  return res;
}

/**
 * Transcribe audio bytes.
 *   buf:      Node Buffer of raw audio (mp3/wav/m4a/ogg/webm/...)
 *   mime:     content-type to send to HF (defaults to audio/mpeg)
 *   language: optional ISO-639-1 hint ('hi', 'en', 'es', ...). Omit for
 *             auto-detect, which Whisper handles well most of the time.
 *
 * Returns { text, chunks, language, model, provider }. Throws on errors.
 */
export async function transcribeViaHF({ buf, mime = 'audio/mpeg', language = '' } = {}) {
  if (!buf || !buf.length) throw new Error('Audio buffer is required');
  if (buf.length > 25 * 1024 * 1024) {
    throw new Error('Audio too large (max 25 MB). Trim before upload.');
  }
  if (!HF_API_KEY) {
    // Without a token, Whisper-large-v3 returns 401 immediately. Fail
    // fast with an actionable message instead of forwarding HF's terse
    // "Invalid credentials in Authorization header".
    throw new Error('HF_TOKEN is not configured on the BE — set it in .env to enable transcription');
  }

  const sendMime = _normalizeMime(mime);
  let lastErr = null;

  for (const build of ENDPOINTS) {
    const url = build(HF_MODEL);
    try {
      const res = await _callOnce({ url, buf, mime: sendMime, language });
      if (res.ok) {
        const json = await res.json();
        return {
          text: (json.text || '').trim(),
          chunks: Array.isArray(json.chunks) ? json.chunks : [],
          language: language || null,
          bytes: buf.length,
          mime: sendMime,
          model: HF_MODEL,
          provider: 'hf',
          endpoint: url,
        };
      }
      const body = await res.text().catch(() => '');
      lastErr = `HF Whisper ${res.status} via ${new URL(url).host}: ${body.slice(0, 300)}`;
      logger.warn(lastErr);
      // 401/403/404 → try the next endpoint. Anything else → bail (4xx
      // about input shape won't get better by switching hosts).
      if (![401, 403, 404].includes(res.status)) break;
    } catch (e) {
      lastErr = `HF Whisper fetch via ${new URL(url).host} failed: ${e.message}`;
      logger.warn(lastErr);
    }
  }

  throw new Error(lastErr || 'HF Whisper failed (no endpoint responded)');
}
