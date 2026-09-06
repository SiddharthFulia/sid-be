// Smoke test for POST /api/tattoo/analyze.
//
// Runs three scenarios against a running BE (assumes it's on
// http://localhost:4001 or whatever process.env.BE_URL points at):
//
//   1. GET /api/tattoo/health          → returns config diagnostics
//   2. POST /api/tattoo/analyze  (no file)  → 400
//   3. POST /api/tattoo/analyze  (fixture PNG) → 200 with a well-shaped
//      analysis object, or 502/503 when Gemini isn't configured (we
//      treat this as expected in local dev — the test just asserts the
//      shape of the error envelope).
//
// The fixture is a 1×1 red PNG generated inline so the script has no
// disk dependency. That means Gemini's analysis will be nonsense but
// the request / response contract is what we're testing.
//
// Usage:
//   node scripts/test-tattoo.mjs
//   BE_URL=https://api.siddharthfulia.com node scripts/test-tattoo.mjs

const BE_URL = process.env.BE_URL || 'http://localhost:4001';

// ─── Tiny assertion helpers ─────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}
function heading(name) {
  console.log(`\n${name}`);
}

// ─── 1×1 red PNG (base64) — the smallest legal PNG that isn't a fake ────
// This decodes to a single red pixel — enough for the endpoint to accept
// it as a valid image/png upload. Gemini will probably return low
// confidence but that's expected for a red dot.
const RED_PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const redPixelBuf = Buffer.from(RED_PIXEL_PNG_B64, 'base64');

// ─── Test 1 · health ────────────────────────────────────────────
async function testHealth() {
  heading('GET /api/tattoo/health');
  const res = await fetch(`${BE_URL}/api/tattoo/health`);
  assert(res.ok, `HTTP ${res.status} === 200`);
  const body = await res.json();
  assert(body.status === true, 'envelope status is true');
  assert(typeof body.data === 'object', 'envelope has data object');
  assert(typeof body.data.configured === 'boolean', 'data.configured is a boolean');
  assert(typeof body.data.enabled === 'boolean', 'data.enabled is a boolean');
  assert(Array.isArray(body.data.allowedMime), 'data.allowedMime is an array');
  console.log(`     -> configured=${body.data.configured} enabled=${body.data.enabled} cacheSize=${body.data.cacheSize}`);
  return body.data;
}

// ─── Test 2 · analyze without image ─────────────────────────────
async function testAnalyzeNoImage() {
  heading('POST /api/tattoo/analyze (no image)');
  const fd = new FormData();
  const res = await fetch(`${BE_URL}/api/tattoo/analyze`, { method: 'POST', body: fd });
  assert(res.status === 400, `HTTP ${res.status} === 400`);
  const body = await res.json();
  assert(body.status === false, 'envelope status is false');
  assert(typeof body.message === 'string' && body.message.length > 0, 'has an error message');
  console.log(`     -> "${body.message}"`);
}

// ─── Test 3 · analyze with a valid image ────────────────────────
async function testAnalyzeWithImage(health) {
  heading('POST /api/tattoo/analyze (red-pixel PNG fixture)');
  const fd = new FormData();
  fd.append('image', new Blob([redPixelBuf], { type: 'image/png' }), 'red.png');
  const res = await fetch(`${BE_URL}/api/tattoo/analyze`, { method: 'POST', body: fd });
  const body = await res.json();
  console.log(`     -> HTTP ${res.status} · status=${body.status} · "${body.message}"`);

  if (!health.ok) {
    // Gemini not configured on this BE — a 503 with a friendly message is
    // the correct behaviour. We assert the envelope but not the analysis.
    assert(res.status === 503, 'HTTP 503 when Gemini is disabled');
    assert(body.status === false, 'envelope status is false');
    return;
  }

  // Gemini configured — we expect a 200 with a well-shaped analysis, OR
  // a 502 if the model refused to produce JSON (rare with the retry).
  if (res.status === 502) {
    console.log('     -> Gemini responded but did not produce parseable JSON. Skipping shape asserts.');
    return;
  }

  assert(res.status === 200, `HTTP ${res.status} === 200`);
  assert(body.status === true, 'envelope status is true');
  const a = body.data?.analysis;
  assert(a && typeof a === 'object', 'analysis is an object');
  if (!a) return;
  assert(typeof a.subject === 'string', 'analysis.subject is a string');
  assert(typeof a.style === 'string', 'analysis.style is a string');
  assert(Array.isArray(a.motifs), 'analysis.motifs is an array');
  assert(Array.isArray(a.dominant_colors), 'analysis.dominant_colors is an array');
  assert(a.dominant_colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)), 'every colour is a #RRGGBB hex');
  assert(typeof a.line_weight === 'string', 'analysis.line_weight is a string');
  assert(typeof a.complexity === 'string', 'analysis.complexity is a string');
  assert(typeof a.energy === 'string', 'analysis.energy is a string');
  assert(typeof a.suggested_qr_payload === 'string', 'analysis.suggested_qr_payload is a string');
  assert(a.suggested_qr_payload.length <= 200, 'suggested_qr_payload ≤ 200 chars');
  assert(a.suggested_qr_style && typeof a.suggested_qr_style === 'object', 'suggested_qr_style is an object');
  assert(/^#[0-9a-f]{6}$/i.test(a.suggested_qr_style.primary_color), 'suggested primary_color is a #RRGGBB hex');
  assert(/^#[0-9a-f]{6}$/i.test(a.suggested_qr_style.secondary_color), 'suggested secondary_color is a #RRGGBB hex');
  assert(typeof a.suggested_qr_style.gradient_direction === 'number', 'gradient_direction is a number');
  assert(a.suggested_qr_style.gradient_direction >= 0 && a.suggested_qr_style.gradient_direction <= 360, 'gradient_direction ∈ [0, 360]');
  assert(a.suggested_qr_style.ecc_level === 'H', 'ecc_level = "H"');
  assert(typeof a.confidence === 'number', 'confidence is a number');
  assert(a.confidence >= 0 && a.confidence <= 1, 'confidence ∈ [0, 1]');
  console.log(`     -> subject="${a.subject}" style=${a.style} energy=${a.energy} confidence=${a.confidence}`);
  console.log(`     -> primary=${a.suggested_qr_style.primary_color} secondary=${a.suggested_qr_style.secondary_color}`);
}

// ─── 4 · analyze again to confirm the cache ─────────────────────
async function testCacheHit(health) {
  if (!health.ok) return;
  heading('POST /api/tattoo/analyze (same image again → cached=true)');
  const fd = new FormData();
  fd.append('image', new Blob([redPixelBuf], { type: 'image/png' }), 'red.png');
  const res = await fetch(`${BE_URL}/api/tattoo/analyze`, { method: 'POST', body: fd });
  const body = await res.json();
  if (res.status !== 200) {
    console.log(`     -> non-200 (${res.status}). Skipping cache assert.`);
    return;
  }
  assert(body.data?.cached === true, 'second call returned cached=true');
}

// ─── Runner ─────────────────────────────────────────────────────
(async () => {
  console.log(`Tattoo analyze smoke test → ${BE_URL}`);
  try {
    const health = await testHealth();
    await testAnalyzeNoImage();
    await testAnalyzeWithImage(health);
    await testCacheHit(health);
  } catch (e) {
    console.error('\nFATAL: could not reach BE.', e.message);
    process.exit(2);
  }
  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
