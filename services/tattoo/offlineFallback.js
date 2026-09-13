// Transform the /api/vision/analyze offline payload into the shape the
// Tattoo Studio FE already expects from /api/tattoo/analyze.
//
// The offline pipeline (YOLO + MediaPipe + Tesseract + k-means) can give us:
//   • dominant_colors — real, extracted from the image
//   • motifs — YOLO's 80-class labels, if any objects were detected
//   • subject — a very rough guess from the top-scoring object
//   • text — raw OCR strings (useful for text-heavy tattoos / posters)
//   • faces — count only, we use it to bias the subject guess
//
// What we CAN'T infer without a specialised classifier:
//   • tattoo `style` (traditional / japanese / geometric …)
//   • `line_weight` (thin / medium / bold)
//   • `energy` (calm / dynamic / aggressive …)
//   • whether the image is even a tattoo
// Those fields are marked `'unknown'` so the FE can show a "install a
// Gemini key for style detection" hint next to them instead of pretending
// to be confident about a value it invented.

const CELL_SHAPES = ['square', 'rounded', 'dot', 'diamond'];
const EYE_SHAPES = ['square', 'rounded', 'leaf', 'circle'];

function safeHex(v, fallback) {
  const s = String(v || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return fallback;
}

// Rough "what does the image show" guess from the highest-confidence YOLO
// label. Faces bias us toward "person portrait" even if YOLO's top hit was
// a background object like "chair".
function guessSubject(objects, faceCount) {
  if (faceCount > 0) {
    return objects.length
      ? `person portrait with ${objects.slice(0, 3).map((o) => o.label).join(', ')}`
      : 'person portrait';
  }
  if (!objects.length) return 'unrecognised subject';
  const top = objects[0];
  return `${top.label}${objects.length > 1 ? ` and ${objects.length - 1} other object${objects.length - 1 > 1 ? 's' : ''}` : ''}`;
}

/**
 * Map the offline vision payload to the tattoo-analyze contract.
 *
 * @param {object} raw — output of controllers/vision/index.js#analyzeBufferOffline
 * @returns {object} — same shape as services/tattoo/gemini.js#normalise
 */
export function offlineToTattooShape(raw = {}) {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  const faces = Array.isArray(raw.faces) ? raw.faces : [];
  const colours = Array.isArray(raw.dominant_colors) ? raw.dominant_colors : [];
  const text = Array.isArray(raw.text) ? raw.text : [];

  // Motifs: up to 6 unique object labels sorted by confidence.
  const motifs = [];
  const seen = new Set();
  for (const o of objects.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
    if (!o.label || seen.has(o.label)) continue;
    seen.add(o.label);
    motifs.push(o.label);
    if (motifs.length >= 6) break;
  }

  // Dominant colours: top-5 hex codes. Fall back to a neutral palette so
  // the FE never renders blank swatches.
  const hexColours = colours
    .map((c) => safeHex(c.hex, null))
    .filter(Boolean)
    .slice(0, 5);
  const safeColours = hexColours.length ? hexColours : ['#0a0a0e', '#f5f5f5', '#94a3b8'];

  const primary = safeColours[0];
  const secondary = safeColours[1] || safeColours[0];

  // OCR: if the image contains readable text (poster / typography tattoo),
  // surface the highest-confidence word as the suggested QR payload — feels
  // more thematic than a generic URL.
  let suggestedPayload = 'https://siddharthfulia.com';
  if (text.length) {
    const best = text
      .slice()
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .find((w) => (w.text || '').length >= 3 && (w.text || '').length <= 60);
    if (best) suggestedPayload = best.text.trim();
  }

  const subject = guessSubject(objects, faces.length);

  return {
    subject,
    // Marked 'unknown' — no offline model classifies tattoo style / line
    // weight / energy. FE should show a "install a Gemini key" hint here.
    style: 'unknown',
    motifs,
    dominant_colors: safeColours,
    line_weight: 'unknown',
    complexity: motifs.length >= 4 || text.length >= 5 ? 'complex'
              : motifs.length >= 2 ? 'moderate'
              : 'simple',
    energy: 'neutral',
    suggested_qr_payload: suggestedPayload,
    suggested_qr_style: {
      cell_shape: CELL_SHAPES.includes('rounded') ? 'rounded' : 'square',
      eye_shape: EYE_SHAPES.includes('rounded') ? 'rounded' : 'square',
      primary_color: primary,
      secondary_color: secondary,
      ecc_level: 'H',
      gradient_direction: 135,
    },
    // Low-ish confidence to signal "this is a heuristic guess, not a
    // vision-model classification". FE can gate rich UI on this.
    confidence: 0.6,
    backend: 'offline',
    // Extra fields the FE can optionally render — not part of the strict
    // Gemini contract but useful when we have them.
    _extra: {
      text: text.map((w) => w.text).slice(0, 20),
      faceCount: faces.length,
      objectCount: objects.length,
      meta: raw.meta || {},
    },
  };
}
