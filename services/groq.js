import { GROQ_API_KEY } from '../helpers/constants.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MODELS = {
  'llama-3.1-8b': 'llama-3.1-8b-instant',
  'llama-3.3-70b': 'llama-3.3-70b-versatile',
  'gpt-oss-120b': 'openai/gpt-oss-120b',
};

// Gemini-alias → Groq text model mapping. Lets `/api/gemini` accept the
// same `model` strings the FE was sending to native Gemini (`gemini-flash`,
// `gemini-pro`, `gemini-flash-lite`) and quietly route them through Groq.
// Tiered by latency/quality so 'flash' stays fast and 'pro' gets quality.
const GEMINI_ALIAS_TO_GROQ = {
  'gemini-flash':       'llama-3.1-8b-instant',
  'gemini-flash-lite':  'llama-3.1-8b-instant',
  'gemini-pro':         'llama-3.3-70b-versatile',
  'gemini-2.5-flash':   'llama-3.1-8b-instant',
  'gemini-2.5-pro':     'llama-3.3-70b-versatile',
  'gemini-2.5-flash-lite': 'llama-3.1-8b-instant',
};

// Groq's current multimodal (vision-capable) model. Llama-4 Scout replaced
// the retired `llama-3.2-90b-vision-preview` lane on Groq. Override via
// the GROQ_VISION_MODEL env var if Groq rotates this in the future.
export const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL
  || 'meta-llama/llama-4-scout-17b-16e-instruct';

export async function chatGroq(message, history = [], model = 'llama-3.1-8b', options = {}) {
  if (!GROQ_API_KEY) throw new Error('Groq API key not configured');

  const modelId = MODELS[model] || model;

  const messages = [
    { role: 'system', content: options.system || 'You are a helpful AI assistant. Be concise and direct.' },
    ...history.slice(-6),
    { role: 'user', content: message },
  ];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: options.maxTokens || 500,
      temperature: options.temperature ?? 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq API error: ${res.status}`);
  }

  const data = await res.json();

  return {
    reply: data.choices?.[0]?.message?.content || '',
    model: data.model,
    tokens: data.usage?.completion_tokens,
    totalTokens: data.usage?.total_tokens,
    duration: null,
    provider: 'groq',
  };
}

/**
 * Gemini-compatible text chat that runs on Groq under the hood.
 *
 * §76 follow-up — `/api/gemini` was returning 503 since we disabled native
 * Gemini to save cost. This helper accepts Gemini's `model` aliases
 * (`gemini-flash`, `gemini-pro`, etc.) and silently rewrites them to a
 * Groq-hosted Llama equivalent. Response envelope mirrors `chatGemini`'s
 * shape — same `reply` / `model` / `tokens` / `totalTokens` fields — but
 * adds `provider: 'gemini-via-groq'` and `originalModel` so the FE can
 * tell the call was rerouted.
 */
export async function chatGroqAsGemini(message, history = [], model = 'gemini-flash', options = {}) {
  if (!GROQ_API_KEY) throw new Error('Groq API key not configured');

  const groqModelId = GEMINI_ALIAS_TO_GROQ[model] || MODELS[model] || 'llama-3.1-8b-instant';

  const messages = [
    { role: 'system', content: options.system || 'You are a helpful AI assistant. Be concise and direct.' },
    ...history.slice(-6),
    { role: 'user', content: message },
  ];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: groqModelId,
      messages,
      max_tokens: options.maxTokens || 500,
      temperature: options.temperature ?? 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq API error (via gemini route): ${res.status}`);
  }

  const data = await res.json();

  return {
    reply: data.choices?.[0]?.message?.content || '',
    model: data.model,            // actual Groq model used
    originalModel: model,         // the gemini alias the caller asked for
    tokens: data.usage?.completion_tokens,
    totalTokens: data.usage?.total_tokens,
    duration: null,
    provider: 'gemini-via-groq',
  };
}

/**
 * Gemini-vision-compatible image analysis routed through Groq's multimodal
 * Llama model. Accepts the same `imageBase64` + `prompt` arguments as
 * `analyzeImageGemini` and returns the same envelope shape with
 * `provider: 'gemini-via-groq'`.
 *
 * Note: Groq expects multimodal input in OpenAI's content-parts format
 * (an array of `{ type: 'text' }` and `{ type: 'image_url' }` parts).
 * The image must be either a public URL or a data: URL — Groq accepts
 * both. We pass it as a data URL so the BE doesn't have to upload first.
 */
export async function analyzeImageGroqAsGemini(imageBase64, prompt = 'Describe this image in detail.', model = 'gemini-flash') {
  if (!GROQ_API_KEY) throw new Error('Groq API key not configured');

  // Normalise the image into a data: URL Groq can consume directly.
  let dataUrl = imageBase64;
  if (!imageBase64.startsWith('data:')) {
    dataUrl = `data:image/jpeg;base64,${imageBase64}`;
  }

  const visionModel = GROQ_VISION_MODEL;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 500,
      temperature: 0.4,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq vision error (via gemini route): ${res.status}`);
  }

  const data = await res.json();
  return {
    reply: data.choices?.[0]?.message?.content || '',
    model: data.model || visionModel,
    originalModel: model,
    tokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
    provider: 'gemini-via-groq',
  };
}
