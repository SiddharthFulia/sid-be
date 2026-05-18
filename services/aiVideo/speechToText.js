// Speech-to-Text via Hugging Face Inference API (Whisper).
// No GPU on the BE — HF runs the model server-side. Free tier rate-limit
// is ~30 req/min which is plenty for individual use. Set HF_TOKEN in
// .env to skip cold-start retries.
//
// Whisper accepts the raw audio bytes (any common codec) and returns
//   { text: "...", chunks?: [...] } in JSON.
//
// We support both "long" mode (with timestamp chunks) and quick mode
// (just the transcription string) via the `chunks` parameter.

import logger from '../../helpers/logger.js';

const HF_API_KEY = process.env.HF_TOKEN || process.env.HF_API_KEY || '';
const HF_BASE = 'https://api-inference.huggingface.co/models';
// Whisper large-v3 is the most accurate; users can override via env if
// they want distil-whisper-large-v3 (~2× faster, slightly less accurate).
const HF_MODEL = process.env.HF_STT_MODEL || 'openai/whisper-large-v3';

/**
 * Transcribe audio bytes.
 *   buf:      Node Buffer of raw audio (mp3/wav/m4a/ogg/...)
 *   mime:     content-type to send to HF (defaults to audio/mpeg)
 *   language: optional ISO-639-1 hint ('hi', 'en', 'es', ...). Omit for
 *             auto-detect, which Whisper handles well most of the time.
 *
 * Returns { text, language, durationSec, model }. Throws on errors.
 */
export async function transcribeViaHF({ buf, mime = 'audio/mpeg', language = '' } = {}) {
  if (!buf || !buf.length) throw new Error('Audio buffer is required');
  if (buf.length > 25 * 1024 * 1024) {
    throw new Error('Audio too large (max 25 MB). Trim before upload.');
  }

  const headers = {
    'Content-Type': mime,
  };
  if (HF_API_KEY) headers.Authorization = `Bearer ${HF_API_KEY}`;

  // Whisper takes parameters via query string when posting raw audio body.
  const params = new URLSearchParams();
  // Force a language hint when provided — Whisper auto-detect is usually
  // good but occasionally guesses the wrong language for short clips or
  // mixed-language speech.
  if (language) params.set('language', language);
  // Return per-chunk timestamps so the FE can render a synced transcript.
  params.set('return_timestamps', 'true');

  const url = `${HF_BASE}/${HF_MODEL}${params.toString() ? `?${params}` : ''}`;

  let res = await fetch(url, { method: 'POST', headers, body: buf });

  // Cold start: HF returns 503 with estimated_time. Retry once.
  if (res.status === 503) {
    const info = await res.json().catch(() => ({}));
    const wait = Math.min((info.estimated_time || 20) * 1000, 30000);
    logger.warn(`HF Whisper warming up — retrying in ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    res = await fetch(url, { method: 'POST', headers, body: buf });
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HF Whisper ${res.status}: ${txt.slice(0, 240)}`);
  }

  const json = await res.json();
  // Response shape: { text, chunks: [{ timestamp: [start, end], text }, ...] }
  return {
    text: (json.text || '').trim(),
    chunks: Array.isArray(json.chunks) ? json.chunks : [],
    language: language || null,
    bytes: buf.length,
    model: HF_MODEL,
    provider: 'hf',
  };
}
