// Speech-to-Text via Hugging Face Inference (Whisper).
// No GPU on the BE — HF runs the model server-side. Set HF_TOKEN in .env;
// without it many models 401 because they're gated.
//
// Why a model FALLBACK chain instead of a single model: HF removed
// `openai/whisper-large-v3` from free serverless inference in late 2024
// (they moved it to paid Inference Providers — fal-ai / replicate). The
// smaller Whisper variants are still on the free serverless tier, so we
// try big → small until one responds. The user gets the best available
// model their HF_TOKEN has access to without having to know any of this.
//
// Override the chain via HF_STT_MODEL=<single-model-id> in .env to force
// a specific model (useful if you have an Inference Endpoint deployed).

import logger from '../../helpers/logger.js';

const HF_API_KEY = process.env.HF_TOKEN || process.env.HF_API_KEY || '';

// Quality order — try the best first, fall back to smaller models that
// are still on the free serverless tier. distil-large-v3 is the closest
// to large quality but is sometimes still served; whisper-small / -base /
// -tiny are the reliable free serverless fallbacks.
const HF_MODEL_CHAIN = (process.env.HF_STT_MODEL || [
  'openai/whisper-large-v3',
  'distil-whisper/distil-large-v3',
  'openai/whisper-small',
  'openai/whisper-base',
  'openai/whisper-tiny',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const ENDPOINTS = [
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
  let abort = false;

  // Outer loop: each candidate model. Inner loop: each endpoint host.
  // Bail out of BOTH on a non-fallback-worthy error (e.g. 400 about the
  // input body — that won't get better by switching models or hosts).
  for (const model of HF_MODEL_CHAIN) {
    if (abort) break;
    for (const build of ENDPOINTS) {
      const url = build(model);
      try {
        const res = await _callOnce({ url, buf, mime: sendMime, language });
        if (res.ok) {
          const json = await res.json();
          if (model !== HF_MODEL_CHAIN[0]) {
            logger.info(`HF Whisper fell back to ${model} (first choice unavailable)`);
          }
          return {
            text: (json.text || '').trim(),
            chunks: Array.isArray(json.chunks) ? json.chunks : [],
            language: language || null,
            bytes: buf.length,
            mime: sendMime,
            model,
            provider: 'hf',
            endpoint: url,
            fellBack: model !== HF_MODEL_CHAIN[0],
          };
        }
        const body = await res.text().catch(() => '');
        lastErr = `HF Whisper ${res.status} via ${new URL(url).host} (${model}): ${body.slice(0, 200)}`;
        logger.warn(lastErr);
        // 404 → model not on this host, try next host then next model.
        // 401/403 → auth issue, fall through to try next host (some hosts
        //           accept tokens others don't).
        // anything else → input-side problem; bail entirely.
        if (![401, 403, 404].includes(res.status)) { abort = true; break; }
      } catch (e) {
        lastErr = `HF Whisper fetch via ${new URL(url).host} (${model}) failed: ${e.message}`;
        logger.warn(lastErr);
      }
    }
  }

  throw new Error(lastErr || 'HF Whisper failed (no endpoint responded)');
}
