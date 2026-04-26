import { HF_TOKEN, GOOGLE_TTS_KEY } from '../helpers/constants.js';

const HF_API = 'https://router.huggingface.co/hf-inference/models';

/**
 * Generate image from text prompt using FLUX.1-schnell (fast, free)
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

/**
 * Summarize text using BART
 */
export async function summarizeText(text, model = 'facebook/bart-large-cnn') {
  if (!HF_TOKEN) throw new Error('Hugging Face token not configured');

  const res = await fetch(`${HF_API}/${model}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: text, parameters: { max_length: 150, min_length: 30 } }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HF Summarize error: ${res.status}`);
  }

  const data = await res.json();
  return {
    summary: data[0]?.summary_text || '',
    model,
    provider: 'huggingface',
  };
}

// ═══ Google Cloud TTS — with cost protection ═══

// Rate limiter: max 10 requests per minute
const ttsRateLimit = { count: 0, resetAt: 0 };
const TTS_MAX_RPM = 10;

// Daily character counter: max 50K chars/day (well under 1M/month free tier)
let ttsDailyChars = 0;
let ttsDayReset = 0;
const TTS_MAX_DAILY_CHARS = 50000;

// Allowed voices (Standard only — free tier, no Neural2/Studio which cost more)
const ALLOWED_VOICES = [
  'en-US-Standard-A', 'en-US-Standard-B', 'en-US-Standard-C', 'en-US-Standard-D',
  'en-US-Standard-E', 'en-US-Standard-F', 'en-US-Standard-G', 'en-US-Standard-H',
  'en-US-Standard-I', 'en-US-Standard-J',
  'en-GB-Standard-A', 'en-GB-Standard-B', 'en-GB-Standard-C', 'en-GB-Standard-D',
  'en-IN-Standard-A', 'en-IN-Standard-B', 'en-IN-Standard-C', 'en-IN-Standard-D',
  'hi-IN-Standard-A', 'hi-IN-Standard-B', 'hi-IN-Standard-C', 'hi-IN-Standard-D',
];

function checkTTSRateLimit() {
  const now = Date.now();
  if (now > ttsRateLimit.resetAt) {
    ttsRateLimit.count = 0;
    ttsRateLimit.resetAt = now + 60000;
  }
  if (ttsRateLimit.count >= TTS_MAX_RPM) {
    throw new Error('TTS rate limit: max 10 requests per minute. Try again shortly.');
  }
  ttsRateLimit.count++;
}

function checkTTSDailyLimit(charCount) {
  const now = Date.now();
  const today = new Date().setHours(0, 0, 0, 0);
  if (today > ttsDayReset) {
    ttsDailyChars = 0;
    ttsDayReset = today + 86400000;
  }
  if (ttsDailyChars + charCount > TTS_MAX_DAILY_CHARS) {
    throw new Error(`TTS daily limit reached (${TTS_MAX_DAILY_CHARS} chars/day). Resets at midnight.`);
  }
  ttsDailyChars += charCount;
}

/**
 * Text to Speech using Google Cloud TTS API
 *
 * Safety limits:
 * - Max 200 characters per request
 * - Max 10 requests per minute
 * - Max 50,000 characters per day
 * - Standard voices only (no Neural2/Studio/WaveNet to avoid charges)
 */
export async function textToSpeech(text, voice = 'en-US-Standard-D', lang = 'en-US') {
  if (!GOOGLE_TTS_KEY) throw new Error('Google TTS key not configured');

  // 1. Text length limit — 200 chars max
  if (!text || text.length === 0) throw new Error('Text is required');
  if (text.length > 200) throw new Error(`Text too long (${text.length} chars). Max 200 characters.`);

  // 2. Voice safety — only allow Standard voices (free tier)
  const safeVoice = ALLOWED_VOICES.includes(voice) ? voice : 'en-US-Standard-D';

  // 3. Rate limit — 10 req/min
  checkTTSRateLimit();

  // 4. Daily character limit — 50K/day
  checkTTSDailyLimit(text.length);

  // 5. Call Google TTS
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lang, name: safeVoice },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('Google TTS quota exceeded. Try again later.');
    throw new Error(err.error?.message || `Google TTS error: ${res.status}`);
  }

  const data = await res.json();
  if (!data.audioContent) throw new Error('No audio returned from Google TTS');

  return {
    audio: `data:audio/mp3;base64,${data.audioContent}`,
    voice: safeVoice,
    chars: text.length,
    dailyUsed: ttsDailyChars,
    dailyLimit: TTS_MAX_DAILY_CHARS,
    provider: 'google',
  };
}
