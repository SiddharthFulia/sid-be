// Transform the /api/vision/analyze offline payload into the shape the
// Tattoo Studio FE already expects from /api/tattoo/analyze.
//
// Two shape variants land in here now:
//
//   • Deep payload (backend: 'deep')  — has BLIP caption + CLIP tags. This
//     gives us a REAL subject description and a data-driven style pick.
//     The tattoo FE gets confidence directly from the top CLIP tag.
//
//   • Light payload (backend: 'light') — no caption, no CLIP. Falls back to
//     YOLO + face count for a heuristic subject, and marks style 'unknown'.
//
// The FE contract stays identical either way — same field names, same enum
// values, same nested `suggested_qr_style`. `backend` is set on the wrapping
// controller response so the FE can show a "deep AI" badge when applicable.

const CELL_SHAPES = ['square', 'rounded', 'dot', 'diamond'];
const EYE_SHAPES = ['square', 'rounded', 'leaf', 'circle'];

// The exact enum the /api/tattoo contract enforces — must match services/tattoo/gemini.js
const TATTOO_STYLES = [
  'traditional', 'neo-traditional', 'japanese', 'blackwork', 'dotwork',
  'watercolor', 'geometric', 'realism', 'fine-line', 'tribal',
  'minimalist', 'biomechanical', 'script',
];

// CLIP prompts for each tattoo style — kept close to the enum but expanded so
// CLIP has enough vocabulary to disambiguate. Prompt template ("a … tattoo")
// is applied on the Python side (`clip_tags` prepends "a photo of" unless the
// string already contains a space, which all of these do).
const STYLE_CLIP_PROMPTS = [
  'a traditional american tattoo',
  'a neo-traditional tattoo',
  'a japanese irezumi tattoo',
  'a blackwork tattoo',
  'a dotwork stippled tattoo',
  'a watercolor style tattoo',
  'a geometric symmetrical tattoo',
  'a photorealistic realism tattoo',
  'a fine-line minimalist tattoo',
  'a tribal blackout tattoo',
  'a minimalist single-line tattoo',
  'a biomechanical mechanical tattoo',
  'a script lettering tattoo',
];

const ENERGY_CLIP_PROMPTS = [
  'a calm serene tattoo',
  'a dynamic energetic tattoo',
  'an aggressive intense tattoo',
  'an ethereal dreamy tattoo',
  'a playful whimsical tattoo',
];
const ENERGY_VALUES = ['calm', 'dynamic', 'aggressive', 'ethereal', 'playful'];

const LINE_WEIGHT_CLIP_PROMPTS = [
  'a tattoo with thin fine lines',
  'a tattoo with medium weight lines',
  'a tattoo with bold heavy lines',
  'a tattoo with mixed line weights',
];
const LINE_WEIGHT_VALUES = ['thin', 'medium', 'bold', 'mixed'];

function safeHex(v, fallback) {
  const s = String(v || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return fallback;
}

// Rough subject guess used ONLY on the light-backend path (no BLIP caption
// available). Faces bias us toward "person portrait" even if YOLO's top hit
// was a background object.
function guessSubjectLight(objects, faceCount) {
  if (faceCount > 0) {
    return objects.length
      ? `person portrait with ${objects.slice(0, 3).map((o) => o.label).join(', ')}`
      : 'person portrait';
  }
  if (!objects.length) return 'unrecognised subject';
  const top = objects[0];
  return `${top.label}${objects.length > 1 ? ` and ${objects.length - 1} other object${objects.length - 1 > 1 ? 's' : ''}` : ''}`;
}

// Match a CLIP-returned label back to a canonical enum value. CLIP tags come
// back as the exact prompt string ("a photorealistic realism tattoo") so we
// look for enum tokens inside them.
function matchEnumFromClipTag(tag, enumValues) {
  const s = String(tag || '').toLowerCase();
  for (const v of enumValues) {
    // Substring match — "japanese" is unique, "geometric" is unique, etc.
    if (s.includes(v)) return v;
  }
  // Handle the "irezumi" alias for japanese.
  if (s.includes('irezumi')) return 'japanese';
  return null;
}

// Pick the highest-scoring CLIP tag that maps to a valid enum value.
function pickEnumFromClipTags(clipTags, prompts, enumValues, fallback) {
  if (!Array.isArray(clipTags) || !clipTags.length) return { value: fallback, confidence: 0 };
  // clipTags is [{ label, score }, ...] sorted by score desc from the Python side.
  for (const t of clipTags) {
    const matched = matchEnumFromClipTag(t.label, enumValues);
    if (matched) return { value: matched, confidence: Number(t.score) || 0 };
  }
  return { value: fallback, confidence: 0 };
}

/**
 * Map the vision-analyze payload (deep OR light) to the tattoo-analyze contract.
 *
 * @param {object} raw — output of controllers/vision/index.js#analyzeBufferDeep
 * @returns {object} — same shape as services/tattoo/gemini.js#normalise
 */
export function offlineToTattooShape(raw = {}) {
  const isDeep = raw.backend === 'deep';
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  const faces = Array.isArray(raw.faces) ? raw.faces : [];
  const colours = Array.isArray(raw.dominant_colors) ? raw.dominant_colors : [];
  const text = Array.isArray(raw.text) ? raw.text : [];
  const clipTags = Array.isArray(raw.clip_tags) ? raw.clip_tags : [];
  const caption = String(raw.caption || '').trim();

  // ─── SUBJECT ────────────────────────────────────────────────
  // Prefer the BLIP caption; fall back to the YOLO heuristic on light backend.
  const subject = caption
    || guessSubjectLight(objects, faces.length)
    || 'unrecognised tattoo';

  // ─── MOTIFS ─────────────────────────────────────────────────
  // Deep: YOLO objects (still 80-class COCO) + top-3 CLIP tags trimmed of the
  // "a photo of a X tattoo" scaffolding.
  // Light: YOLO objects only.
  const motifs = [];
  const seen = new Set();
  for (const o of objects.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
    if (!o.label || seen.has(o.label)) continue;
    seen.add(o.label);
    motifs.push(o.label);
    if (motifs.length >= 4) break;
  }
  if (isDeep) {
    // Trim scaffolding from CLIP labels — "a japanese irezumi tattoo" → "irezumi".
    for (const t of clipTags.slice(0, 4)) {
      const tokens = String(t.label || '')
        .toLowerCase()
        .replace(/^a photo of |^a |^an /, '')
        .replace(/ tattoo$/, '')
        .replace(/ style$/, '')
        .split(/\s+/)
        .filter(Boolean);
      const motif = tokens.slice(-1)[0]; // last non-scaffolding token
      if (motif && !seen.has(motif)) {
        seen.add(motif);
        motifs.push(motif);
        if (motifs.length >= 6) break;
      }
    }
  }

  // ─── STYLE, LINE WEIGHT, ENERGY ─────────────────────────────
  // Only meaningful when CLIP fired. Light backend falls back to 'unknown'.
  let style = 'unknown';
  let styleConfidence = 0;
  let lineWeight = 'unknown';
  let energy = 'neutral';

  if (isDeep && clipTags.length) {
    // The Python side gave us CLIP scores against DEFAULT_CLIP_LABELS by default.
    // For a proper style pick we want CLIP scored against our curated tattoo
    // prompts. Since the deep-analyze call didn't include those labels, we
    // *approximate* style from whatever tags CLIP returned by matching against
    // enum tokens. The tattoo endpoint below re-runs CLIP with our curated
    // labels for a real confidence — this branch is the "already ran CLIP,
    // just extract what we can" cheap path.
    const st = pickEnumFromClipTags(clipTags, STYLE_CLIP_PROMPTS, TATTOO_STYLES, 'blackwork');
    if (st.confidence > 0) {
      style = st.value;
      styleConfidence = st.confidence;
    }
    const lw = pickEnumFromClipTags(clipTags, LINE_WEIGHT_CLIP_PROMPTS, LINE_WEIGHT_VALUES, 'medium');
    if (lw.confidence > 0) lineWeight = lw.value;
    const en = pickEnumFromClipTags(clipTags, ENERGY_CLIP_PROMPTS, ENERGY_VALUES, 'calm');
    if (en.confidence > 0) energy = en.value;
  }

  // ─── COLOURS ────────────────────────────────────────────────
  const hexColours = colours
    .map((c) => safeHex(c.hex, null))
    .filter(Boolean)
    .slice(0, 5);
  const safeColours = hexColours.length ? hexColours : ['#0a0a0e', '#f5f5f5', '#94a3b8'];
  const primary = safeColours[0];
  const secondary = safeColours[1] || safeColours[0];

  // ─── QR PAYLOAD ─────────────────────────────────────────────
  // OCR text if present, else a generic portfolio URL.
  let suggestedPayload = 'https://siddharthfulia.com';
  if (text.length) {
    const best = text
      .slice()
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .find((w) => (w.text || '').length >= 3 && (w.text || '').length <= 60);
    if (best) suggestedPayload = best.text.trim();
  }

  // ─── COMPLEXITY ─────────────────────────────────────────────
  const complexity = motifs.length >= 4 || text.length >= 5
    ? 'complex'
    : motifs.length >= 2 ? 'moderate' : 'simple';

  // ─── CONFIDENCE ─────────────────────────────────────────────
  // Deep backend → use CLIP's top score if we got one; otherwise a middling
  // heuristic. Light backend → hard-code 0.6 to signal "this is a guess".
  const confidence = isDeep
    ? Math.max(0.5, Math.min(0.98, styleConfidence || (caption ? 0.75 : 0.6)))
    : 0.6;

  return {
    subject: subject.slice(0, 240),
    style,
    motifs: motifs.slice(0, 6),
    dominant_colors: safeColours,
    line_weight: lineWeight,
    complexity,
    energy,
    suggested_qr_payload: suggestedPayload,
    suggested_qr_style: {
      cell_shape: CELL_SHAPES.includes('rounded') ? 'rounded' : 'square',
      eye_shape: EYE_SHAPES.includes('rounded') ? 'rounded' : 'square',
      primary_color: primary,
      secondary_color: secondary,
      ecc_level: 'H',
      gradient_direction: 135,
    },
    confidence,
    backend: isDeep ? 'deep' : 'offline',
    _extra: {
      caption: caption || null,
      clip_tags: clipTags.slice(0, 8),
      text: text.map((w) => w.text).slice(0, 20),
      faceCount: faces.length,
      objectCount: objects.length,
      meta: raw.meta || {},
      models_used: Array.isArray(raw.models_used) ? raw.models_used : [],
    },
  };
}

// ─── Public: curated CLIP prompts (used by the tattoo controller to run a
// second CLIP call with tattoo-specific labels for a real style confidence)
export {
  STYLE_CLIP_PROMPTS,
  TATTOO_STYLES,
  ENERGY_CLIP_PROMPTS,
  ENERGY_VALUES,
  LINE_WEIGHT_CLIP_PROMPTS,
  LINE_WEIGHT_VALUES,
};
