import { GEMINI_API_KEY } from '../helpers/constants.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const MODELS = {
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-pro': 'gemini-2.5-pro',
  'gemini-flash-lite': 'gemini-2.5-flash-lite',
};

/**
 * Chat with Gemini (text only)
 */
export async function chatGemini(message, history = [], model = 'gemini-flash', options = {}) {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');

  const modelId = MODELS[model] || model;

  // Build contents array (Gemini format)
  const contents = [];

  // System instruction (separate from contents in Gemini API)
  const systemInstruction = options.system || 'You are a helpful AI assistant. Be concise and direct.';

  // History
  for (const msg of history.slice(-6)) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  // Current message
  contents.push({ role: 'user', parts: [{ text: message }] });

  const res = await fetch(`${BASE_URL}/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: {
        maxOutputTokens: options.maxTokens || 500,
        temperature: options.temperature ?? 0.7,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API error: ${res.status}`);
  }

  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const tokens = data.usageMetadata?.candidatesTokenCount || 0;

  return {
    reply,
    model: modelId,
    tokens,
    totalTokens: data.usageMetadata?.totalTokenCount || 0,
    provider: 'gemini',
  };
}

/**
 * Analyze image with Gemini (vision)
 */
export async function analyzeImageGemini(imageBase64, prompt = 'Describe this image in detail.', model = 'gemini-flash') {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');

  const modelId = MODELS[model] || model;

  // Strip data URI prefix if present
  let base64Data = imageBase64;
  let mimeType = 'image/jpeg';
  if (imageBase64.includes(',')) {
    const match = imageBase64.match(/^data:(image\/\w+);base64,/);
    if (match) mimeType = match[1];
    base64Data = imageBase64.split(',')[1];
  }

  const res = await fetch(`${BASE_URL}/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } },
        ],
      }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.4 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini Vision error: ${res.status}`);
  }

  const data = await res.json();
  return {
    reply: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    model: modelId,
    tokens: data.usageMetadata?.candidatesTokenCount || 0,
    provider: 'gemini',
  };
}

/**
 * Image enhancement / transformation via Gemini 2.5 Flash Image (image-out model).
 * Takes an input image (base64) + an instruction prompt, returns enhanced image bytes.
 *
 * The "image" model variant supports inline image output in addition to text — we
 * pluck the first inlineData part from the response.
 *
 * Used by /api/image-enhance for the "Image Enhancer" page (cinematic upscale,
 * 4K detail recovery, Hong Kong night film look, etc.).
 */
export async function enhanceImageGemini(imageBase64, prompt) {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');

  let base64Data = imageBase64;
  let mimeType = 'image/jpeg';
  if (imageBase64.includes(',')) {
    const match = imageBase64.match(/^data:(image\/\w+);base64,/);
    if (match) mimeType = match[1];
    base64Data = imageBase64.split(',')[1];
  }

  // Try `-preview` first (current image-out model name in Google's docs);
  // fall back to the alias if -preview returns 404 (depends on the API key's
  // model access). Text part goes BEFORE inlineData — image-edit models
  // honour the instruction more reliably with that order.
  const modelCandidates = ['gemini-2.5-flash-image-preview', 'gemini-2.5-flash-image'];
  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: base64Data } },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  };

  let res, lastErrText = '';
  let modelId = modelCandidates[0];
  for (const candidate of modelCandidates) {
    modelId = candidate;
    res = await fetch(`${BASE_URL}/models/${candidate}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (res.ok) break;
    if (res.status === 404) {
      // Model not in this project's allowlist — try the next candidate.
      lastErrText = `${candidate} → 404`;
      continue;
    }
    // 429, 500, etc — surface the error directly, no fallback retry.
    break;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = err.error?.message || `${res.status}${lastErrText ? ` (${lastErrText})` : ''}`;
    throw new Error(`Gemini Image error: ${detail}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);
  if (!imagePart) {
    // Surface the actual reason. Possible causes (with diagnostic clues):
    //   • finishReason='SAFETY'         — prompt or image tripped a filter
    //   • finishReason='RECITATION'     — copyright filter
    //   • parts has only text           — model declined to output image
    //   • promptFeedback.blockReason    — input was rejected before generation
    const textPart = parts.find(p => p.text);
    const finish = data.candidates?.[0]?.finishReason;
    const block = data.promptFeedback?.blockReason;
    const safetyRatings = data.candidates?.[0]?.safetyRatings || data.promptFeedback?.safetyRatings;
    const detail = [
      finish && `finishReason=${finish}`,
      block && `blockReason=${block}`,
      textPart?.text && `text="${textPart.text.slice(0, 200)}"`,
      safetyRatings?.length && `safety=${JSON.stringify(safetyRatings).slice(0, 200)}`,
    ].filter(Boolean).join(' | ');
    throw new Error(detail
      ? `Gemini returned no image — ${detail}`
      : `Gemini returned no image data (raw: ${JSON.stringify(data).slice(0, 400)})`);
  }
  return {
    base64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png',
    model: modelId,
    provider: 'gemini',
  };
}
