// Gemini Vision wrapper for the Tattoo → AI-styled QR feature.
//
// One export: analyzeTattooWithGemini({ imageBase64, mimeType }) — returns
// the parsed JSON blob described in the /api/tattoo/analyze contract.
//
// We don't reuse services/gemini.js's `analyzeImageGemini` for two reasons:
//   1. That helper caps maxOutputTokens at 500 which is too small for our
//      structured JSON response (dominant_colors + motifs + style + …).
//   2. It also gates on GEMINI_ENABLED (the cost-saving switch, §76). The
//      tattoo endpoint is a first-class feature, not a fallback path, so we
//      keep the same "must-be-configured" guard but use a dedicated model
//      call with JSON-response-mode turned on so we don't rely on the model
//      remembering to wrap the JSON in a code fence.
//
// Retry policy: one retry with a stronger "RESPOND ONLY WITH JSON" prompt,
// then throw. The controller maps the throw to a 502.
import { GEMINI_API_KEY } from '../../helpers/constants.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Vision-capable models in order of preference. gemini-2.0-flash-exp is the
// current "cheap fast vision" option; -1.5-pro is the fallback for accounts
// whose API key doesn't have -2.0 access yet.
const MODEL_CANDIDATES = [
  'gemini-2.0-flash-exp',
  'gemini-1.5-pro',
  'gemini-2.5-flash',
];

const GEMINI_ENABLED = (process.env.GEMINI_ENABLED || '').trim() === '1';

// The prompt template. Kept as a constant so retries reuse the same base and
// only append a stricter suffix when the first attempt fails to parse.
const BASE_PROMPT = `Analyze this tattoo image. Return STRICT JSON with these fields (no code fences, no prose, just the JSON object):
{
  "subject": "one-line description of what the tattoo depicts",
  "style": "traditional | neo-traditional | japanese | tribal | geometric | realism | watercolor | blackwork | dotwork | minimalist | fine-line | biomechanical | script",
  "motifs": ["array of key visual elements — max 6"],
  "dominant_colors": ["array of hex codes — max 5"],
  "line_weight": "thin | medium | bold | mixed",
  "complexity": "simple | moderate | complex",
  "energy": "calm | dynamic | aggressive | ethereal | playful",
  "suggested_qr_payload": "a short URL or text that thematically fits the tattoo — max 200 chars",
  "suggested_qr_style": {
    "cell_shape": "square | rounded | dot | diamond",
    "eye_shape": "square | rounded | leaf | circle",
    "primary_color": "hex code from dominant_colors",
    "secondary_color": "hex code from dominant_colors or complement",
    "ecc_level": "H",
    "gradient_direction": 0
  },
  "confidence": 0.0
}
Rules:
- Every hex code MUST be #RRGGBB (6 hex chars, uppercase or lowercase).
- gradient_direction is an integer 0..360.
- confidence is a float in [0, 1].
- style / line_weight / complexity / energy / cell_shape / eye_shape MUST be one of the listed enum values (case-insensitive is OK).
- suggested_qr_payload should feel like something the tattoo's wearer would actually share — not a generic URL.`;

const STRICT_SUFFIX = `\n\nCRITICAL: your previous response was not valid JSON. RESPOND ONLY WITH VALID JSON. No markdown, no code fences, no explanations. Just the object starting with { and ending with }.`;

async function callGemini({ imageBase64, mimeType, prompt, modelId }) {
  const res = await fetch(`${BASE_URL}/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageBase64 } },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.35,
        // JSON response mode — tells the model to skip its usual chat framing.
        // Not all vision models honour it; harmless when they don't.
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = err.error?.message || `${res.status}`;
    const wrapped = new Error(`Gemini Vision (${modelId}): ${detail}`);
    wrapped.status = res.status;
    wrapped.modelId = modelId;
    throw wrapped;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) {
    throw new Error(`Gemini returned no text (finish=${data.candidates?.[0]?.finishReason || 'unknown'})`);
  }
  return text;
}

// Strip ```json … ``` fences if the model ignored the "no code fence" ask.
function unwrapMaybeFenced(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function tryParse(text) {
  const clean = unwrapMaybeFenced(text);
  try { return JSON.parse(clean); } catch {}
  // Fallback: try to extract the first {...} block by brace counting. Cheap
  // safety net for models that prepended a "Sure! Here's the JSON:" preamble.
  const start = clean.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(clean.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Coerce enum / colour values into the shape the FE expects. We don't reject
// the whole analysis if one field wobbles — we normalise + fall back so the
// UI always has something to render.
const STYLE_VALUES = ['traditional', 'neo-traditional', 'japanese', 'tribal', 'geometric', 'realism', 'watercolor', 'blackwork', 'dotwork', 'minimalist', 'fine-line', 'biomechanical', 'script'];
const LINE_WEIGHT_VALUES = ['thin', 'medium', 'bold', 'mixed'];
const COMPLEXITY_VALUES = ['simple', 'moderate', 'complex'];
const ENERGY_VALUES = ['calm', 'dynamic', 'aggressive', 'ethereal', 'playful'];
const CELL_SHAPE_VALUES = ['square', 'rounded', 'dot', 'diamond'];
const EYE_SHAPE_VALUES = ['square', 'rounded', 'leaf', 'circle'];
const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function pickEnum(v, set, fallback) {
  const s = String(v || '').toLowerCase().trim();
  if (set.includes(s)) return s;
  // Some models return "Japanese (irezumi)" — grab the first alpha token.
  const first = s.split(/[\s(]/)[0];
  if (set.includes(first)) return first;
  return fallback;
}

function pickHex(v, fallback) {
  const s = String(v || '').trim();
  if (HEX_RE.test(s)) return s.toLowerCase();
  // Accept 3-digit shorthand too.
  const short = s.match(/^#([0-9a-fA-F]{3})$/);
  if (short) return ('#' + short[1].split('').map(c => c + c).join('')).toLowerCase();
  return fallback;
}

function pickInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pickFloat(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalise(raw) {
  const dominant = Array.isArray(raw?.dominant_colors) ? raw.dominant_colors : [];
  const cleanedColors = dominant
    .map((c) => pickHex(c, null))
    .filter(Boolean)
    .slice(0, 5);
  // Fallback palette — a "no-op" grayscale so the FE never renders blanks.
  const safeColors = cleanedColors.length ? cleanedColors : ['#0a0a0e', '#f5f5f5', '#94a3b8'];

  const motifs = (Array.isArray(raw?.motifs) ? raw.motifs : [])
    .map((m) => String(m || '').trim())
    .filter(Boolean)
    .slice(0, 6);

  const style = pickEnum(raw?.style, STYLE_VALUES, 'blackwork');
  const suggested = raw?.suggested_qr_style || {};

  return {
    subject: String(raw?.subject || '').trim().slice(0, 240) || 'unrecognised tattoo',
    style,
    motifs,
    dominant_colors: safeColors,
    line_weight: pickEnum(raw?.line_weight, LINE_WEIGHT_VALUES, 'medium'),
    complexity: pickEnum(raw?.complexity, COMPLEXITY_VALUES, 'moderate'),
    energy: pickEnum(raw?.energy, ENERGY_VALUES, 'calm'),
    suggested_qr_payload: String(raw?.suggested_qr_payload || '').trim().slice(0, 200)
      || 'https://siddharthfulia.com/qr',
    suggested_qr_style: {
      cell_shape: pickEnum(suggested.cell_shape, CELL_SHAPE_VALUES, 'rounded'),
      eye_shape: pickEnum(suggested.eye_shape, EYE_SHAPE_VALUES, 'rounded'),
      primary_color: pickHex(suggested.primary_color, safeColors[0]),
      secondary_color: pickHex(suggested.secondary_color, safeColors[1] || safeColors[0]),
      ecc_level: 'H',
      gradient_direction: pickInt(suggested.gradient_direction, 0, 360, 135),
    },
    confidence: pickFloat(raw?.confidence, 0, 1, 0.6),
  };
}

/**
 * Analyse a tattoo image with Gemini Vision.
 *
 * @param {object} args
 * @param {string} args.imageBase64  raw base64 (no data-URI prefix)
 * @param {string} args.mimeType     e.g. 'image/jpeg'
 * @returns {Promise<{ analysis: object, modelId: string }>}
 */
export async function analyzeTattooWithGemini({ imageBase64, mimeType }) {
  if (!GEMINI_ENABLED) {
    // Explicit signal to the controller so it can surface a friendly message
    // instead of a generic 502.
    const err = new Error('Gemini is disabled on this BE. Set GEMINI_ENABLED=1 in .env.');
    err.code = 'GEMINI_DISABLED';
    throw err;
  }
  if (!GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not configured.');
    err.code = 'GEMINI_MISSING_KEY';
    throw err;
  }

  let lastErr = null;
  // First pass: base prompt.
  for (const modelId of MODEL_CANDIDATES) {
    try {
      const text = await callGemini({ imageBase64, mimeType, prompt: BASE_PROMPT, modelId });
      const parsed = tryParse(text);
      if (parsed) return { analysis: normalise(parsed), modelId };
      lastErr = new Error(`Model ${modelId} did not return valid JSON on first try`);
    } catch (e) {
      lastErr = e;
      // 404 = model not in our allowlist — try next candidate. Anything else,
      // still try the next model so a transient 5xx doesn't tank the whole call.
      if (e.status && e.status !== 404 && e.status < 500) break;
    }
  }

  // Second pass: strict-JSON-only prompt on the first working model.
  for (const modelId of MODEL_CANDIDATES) {
    try {
      const text = await callGemini({
        imageBase64, mimeType,
        prompt: BASE_PROMPT + STRICT_SUFFIX,
        modelId,
      });
      const parsed = tryParse(text);
      if (parsed) return { analysis: normalise(parsed), modelId };
      lastErr = new Error(`Model ${modelId} refused valid JSON on retry`);
    } catch (e) {
      lastErr = e;
      if (e.status && e.status !== 404 && e.status < 500) break;
    }
  }

  const err = new Error(`Tattoo analysis failed: ${lastErr?.message || 'unknown error'}`);
  err.code = 'GEMINI_PARSE_FAILED';
  throw err;
}
