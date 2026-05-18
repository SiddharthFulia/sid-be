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

async function _callOnce({ url, buf, mime }) {
  const headers = { 'Content-Type': mime };
  if (HF_API_KEY) headers.Authorization = `Bearer ${HF_API_KEY}`;

  // NOTE: HF's serverless ASR endpoint accepts the raw audio body but
  // does NOT accept `language` as a query param — it routes through the
  // `AutomaticSpeechRecognitionPipeline._sanitize_parameters` which only
  // recognises a small set of generation kwargs. Passing `language=…`
  // returns 400 "unexpected keyword argument 'language'".
  //
  // `return_timestamps` is also rejected on some hosts, so we omit
  // EVERY query parameter and rely on Whisper's auto-language detection.
  // (Auto-detect is excellent for clips ≥10s in practice.) Callers that
  // need a forced language should target whisper-tiny/.en variants or
  // deploy their own Inference Endpoint with custom routing.
  let res = await fetch(url, { method: 'POST', headers, body: buf });

  // Cold start: HF returns 503 with estimated_time. Retry once.
  if (res.status === 503) {
    const info = await res.json().catch(() => ({}));
    const wait = Math.min((info.estimated_time || 20) * 1000, 30000);
    logger.warn(`HF Whisper warming up — retrying in ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    res = await fetch(url, { method: 'POST', headers, body: buf });
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

  if (language) {
    // Surface it but don't act on it — auto-detect handles most cases
    // and the raw-audio endpoint can't accept a language hint.
    logger.info(`STT language hint '${language}' ignored — using Whisper auto-detect`);
  }

  // Outer loop: each candidate model. Inner loop: each endpoint host.
  // Most 4xx errors are model/host specific (e.g. 415 unsupported MIME,
  // 422 model can't process this clip) and the next model might still
  // work — so we DON'T abort the chain on them. Only abort on 413
  // (payload too large) since that's a hard limit.
  for (const model of HF_MODEL_CHAIN) {
    if (abort) break;
    for (const build of ENDPOINTS) {
      const url = build(model);
      try {
        const res = await _callOnce({ url, buf, mime: sendMime });
        if (res.ok) {
          const json = await res.json();
          if (model !== HF_MODEL_CHAIN[0]) {
            logger.info(`HF Whisper fell back to ${model} (first choice unavailable)`);
          }
          return {
            text: (json.text || '').trim(),
            chunks: Array.isArray(json.chunks) ? json.chunks : [],
            language: language || null,
            languageHonored: false,   // raw-audio endpoint can't honor hints
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
        // Only abort on payload-too-large — every other 4xx might succeed
        // on a different model/host (the older / smaller Whisper builds
        // accept different parameter sets).
        if (res.status === 413) { abort = true; break; }
      } catch (e) {
        lastErr = `HF Whisper fetch via ${new URL(url).host} (${model}) failed: ${e.message}`;
        logger.warn(lastErr);
      }
    }
  }

  throw new Error(lastErr || 'HF Whisper failed (no endpoint responded)');
}
