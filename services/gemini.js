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

  // gemini-2.5-flash-image supports both text-out and image-out; we want image-out.
  const modelId = 'gemini-2.5-flash-image';
  const res = await fetch(`${BASE_URL}/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: prompt },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini Image error: ${res.status}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);
  if (!imagePart) {
    // Fall back to the text response so the caller can show *something*.
    const textPart = parts.find(p => p.text);
    throw new Error(
      textPart?.text
        ? `Gemini returned text instead of an image: ${textPart.text.slice(0, 200)}`
        : 'Gemini returned no image data'
    );
  }
  return {
    base64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png',
    model: modelId,
    provider: 'gemini',
  };
}
