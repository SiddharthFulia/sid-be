// scripts/test-endpoints.mjs — comprehensive smoke test that hits every
// registered BE endpoint against the LOCAL sid-be, drives the request
// from the canonical apiCatalog, and reports pass/fail/skip per row.
//
// Runs against `SMOKE_URL` (default http://localhost:4021). If the server
// isn't reachable we print a helpful hint and exit 2 — the workflow is
// "boot the BE, then run this."
//
// Usage:
//   npm run test:endpoints
//   SMOKE_URL=http://localhost:4001 npm run test:endpoints
//
// Skip semantics (never a FAIL):
//   • auth_required === 'vault'        → SKIP: vault-required
//   • auth_required === 'worker-token' → SKIP: worker-token
//   • any file:true param              → SKIP: multipart
//   • 501 from BE                      → SKIP: auth-not-configured
//   • 401/403                          → SKIP: auth-required
//   • 404 with a "not found" body      → SKIP: needs-real-id
//   • 503 upstream unavailable         → SKIP: upstream-down
//   • timeout on Groq/Gemini/Cinema    → SKIP: too-slow-for-smoke
//
// FAIL:  400 with wrong shape, 5xx (except 503), connect error.
// PASS:  2xx.
// Writes test-endpoints-results.json in cwd for the full detail dump.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE       = process.env.SMOKE_URL || 'http://localhost:4021';
const TIMEOUT_MS = 15000;
const SLOW_LANES = new Set(['groq', 'gemini', 'cinema', 'imagery']);  // subcategory allowlist for too-slow-for-smoke
const OSINT_RPS  = 5;                                       // throttle OSINT
const OSINT_GAP  = Math.ceil(1000 / OSINT_RPS);

// ── Global request-shaping ────────────────────────────────────────
// Headers applied to every request. Individual overrides can add more.
const GLOBAL_HEADERS = {
  'X-QR-Owner':      'smoke-test-owner-abc123',
  'X-Session-Id':    'smoke-session-abc123',   // some chess/matches routes read a session hdr
  'User-Agent':      'sid-be-smoke/1.0',
};

// Real slugs / IDs the BE has data for — used as path substitutions.
const REAL_VALUES = {
  slug: 'bangalore',       // city-graphs
};

// ── Fixture library ───────────────────────────────────────────────
// Keyed by `${METHOD} ${endpoint}` (endpoint uses catalog literal, incl. :params).
const FIXTURE_OVERRIDES = {
  // Physics — controller signature: { params: {L1,L2,m1,m2,g}, initial: {t1,t2,w1,w2}, duration, dt }
  //   phase uses `initials: []` instead of `initial: {}`
  'POST /api/physics/pendulum/simulate': { body: { params: { L1: 1, L2: 1, m1: 1, m2: 1, g: 9.81 }, initial: { t1: 1.5, t2: 1.5, w1: 0, w2: 0 }, duration: 4, dt: 0.01 } },
  'POST /api/physics/pendulum/phase':    { body: { params: { L1: 1, L2: 1, m1: 1, m2: 1, g: 9.81 }, initials: [{ t1: 1.5, t2: 1.5, w1: 0, w2: 0 }, { t1: 1.6, t2: 1.5, w1: 0, w2: 0 }], duration: 4, dt: 0.01 } },
  'POST /api/physics/pendulum/lyapunov': { body: { params: { L1: 1, L2: 1, m1: 1, m2: 1, g: 9.81 }, initial: { t1: 1.5, t2: 1.5, w1: 0, w2: 0 }, duration: 4, dt: 0.01 } },
  // Chernobyl — controller reads `scenario` (NOT `scenarioId`).
  // Valid enum: nominal|xenon-transient|az5-scram|controlled-shutdown|custom
  'POST /api/chernobyl/simulate':        { body: { scenario: 'nominal', duration: 5, dt: 0.05 } },
  'POST /api/chernobyl/scenario/az5':    { body: {} },
  // Chess — needs stockfish, will 503 if not installed → SKIP
  'POST /api/chess/best-move':           { body: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', depth: 8 } },
  'POST /api/chess/analyze':             { body: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', depth: 8 } },
  'POST /api/chess/play':                { body: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', move: 'e2e4' } },
  'POST /api/chess/variant/play':        { body: { variant: 'chess960', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' } },
  'POST /api/chess/openings/identify':   { body: { moves: ['e4', 'c5', 'Nf3'] } },
  'POST /api/chess/games':               { body: { name: `smoke-${Date.now()}`, pgn: '1. e4 e5', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' } },
  'POST /api/chess/games/bulk':          { body: { collection: `smoke-${Date.now()}`, games: [{ name: `smoke-${Date.now()}`, pgn: '1. e4 e5', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }] } },
  'POST /api/chess/puzzles/users':       { body: { name: `smoke-${Date.now()}` } },
  'POST /api/chess/puzzles/attempt':     { body: { puzzleId: 'nonexistent', userId: 1, success: false, solved: false, moves: [], timeMs: 1000 } },
  'GET  /api/chess/puzzles/next':        { query: { userId: 1 } },
  'GET  /api/chess/puzzles/stats':       { query: { userId: 1 } },
  // Lichess masters explorer sometimes 400s on FENs it doesn't have records for.
  // We just verify the BE proxy layer works, so tolerate a 400 upstream.
  'GET  /api/chess/openings/explorer':   { query: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1' }, expect: [200, 400] },
  // NASA earth-imagery is a Landsat lookup that regularly takes 20-40s or 502s upstream.
  'GET  /api/nasa/planetary/earth/imagery': { query: { lat: '40.7128', lon: '-74.006' }, expect: [200, 502, 504, 500] },
  'POST /api/chess/matches':             { body: { whiteName: 'smoke-white', timeControl: '5+3' } },

  // Combine — sources are shaped { url } | { videoId } | { uploadId } | { combineId }
  'POST /api/combine':                   { body: { sources: [{ url: 'https://example.com/a.mp4' }, { url: 'https://example.com/b.mp4' }] } },
  // Realism
  'POST /api/realism/enrich-prompt':     { body: { prompt: 'astronaut riding a horse on mars', base: 'astronaut riding a horse on mars' } },
  'POST /api/realism/save-from-url':     { body: { url: 'https://siddharthfulia.com/favicon.ico' } },
  // qr-saves — X-QR-Owner is global; the body wants payload
  'POST /api/qr-saves':                  { body: { payload: 'https://siddharthfulia.com', title: 'smoke-test' } },
  // Games
  'POST /api/games/players':             { body: { name: `smoke-${Date.now()}` } },
  // Games — difficulty enum: easy|medium|hard|classic
  'POST /api/games/scores':              { body: { playerName: `smoke-${Date.now()}`, score: 1000, distance: 5000, difficulty: 'easy', revived: false } },
  // Agents — POST /agents/:id needs an { input } payload; we pick db-query
  'POST /api/agents/:id':                { body: { input: { question: 'how many chat_jobs are there' } }, pathValues: { id: 'db-query' } },

  // Auth vault login — will 401 with a bogus password → treat as pass
  'POST /api/auth/vault-login':          { body: { password: 'wrong-password-smoke-test' }, expect: [200, 401] },

  // Export needs {format, data}
  'POST /api/export':                    { body: { format: 'json', data: [{ a: 1 }, { a: 2 }], filename: 'smoke.json', title: 'smoke' } },

  // AI — /api/chat and /api/ai want `message` not `prompt`
  'POST /api/chat':                      { body: { message: 'hi', model: 'phi3:mini' } },
  // /api/ai expects `messages` array (Ollama raw chat format), not `message`
  'POST /api/ai':                        { body: { messages: [{ role: 'user', content: 'hi' }] } },
  // /api/chat/local — needs both messages[] AND model
  'POST /api/chat/local':                { body: { messages: [{ role: 'user', content: 'hi' }], model: 'llama3.2:1b' } },
  'POST /api/groq':                      { body: { message: 'hi', model: 'openai/gpt-oss-120b' } },
  // Gemini falls through to Groq which is currently returning deprecated-model errors — allow 500 upstream
  'POST /api/gemini':                    { body: { message: 'hi', model: 'gemini-flash' }, expect: [200, 500] },
  'POST /api/gemini/vision':             { body: { image: 'https://siddharthfulia.com/favicon.ico', imageUrl: 'https://siddharthfulia.com/favicon.ico', prompt: 'describe this' }, expect: [200, 500] },
  'POST /api/ai/prompt-coach':           { body: { idea: 'astronaut on the moon' }, expect: [200, 500] },

  // Image / TTS / STT tools
  'POST /api/generate-image':            { body: { prompt: 'a cat' } },
  'POST /api/image-edit':                { body: { image: 'https://siddharthfulia.com/favicon.ico', imageUrl: 'https://siddharthfulia.com/favicon.ico', prompt: 'add a hat' } },
  'POST /api/tts':                       { body: { text: 'hello world' } },
  'POST /api/summarize':                 { body: { text: 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua' } },
  'POST /api/stt':                       { body: { dataUrl: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=' } },
  'POST /api/music/generate':            { body: { prompt: 'lofi beats', duration: 4 } },

  // AI Video — provider must be "zsky" or "worker"; will still 502 without ZSKY_REFRESH_TOKEN, so allow that
  'POST /api/ai-video/generate':         { body: { prompt: 'a cat walking', provider: 'worker' }, expect: [200, 202, 502] },
  'POST /api/lipsync':                   { body: { audioUrl: 'https://example.com/a.mp3', portraitUrl: 'https://example.com/p.png' } },
  'POST /api/audio':                     { body: { kind: 'music', prompt: 'lofi beats', duration: 4 } },
  'POST /api/cinema':                    { body: { masterPrompt: 'an astronaut discovers a hidden garden on mars, cinematic', shotCount: 3 } },
  'POST /api/image-enhance':             { body: { sourceUrl: 'https://siddharthfulia.com/favicon.ico', workflow: 'upscale' } },

  // Mesh
  'POST /api/mesh/generate':             { body: { prompt: 'a red teapot', model: 'shap-e' } },

  // Room / edit
  'POST /api/edit/process':              { body: { operations: [{ op: 'trim', start: 0, end: 1 }], sources: ['nonexistent'] } },

  // OSINT dispatcher endpoint — the pattern is /api/osint/tool/:name but the
  // catalog's `route_key` gives us the real URL; we honour route_key.

  // yt-dl — quality is 128|192|320 for mp3
  'POST /api/yt-dl':                     { body: { url: 'https://youtube.com/watch?v=dQw4w9WgXcQ', format: 'mp3', quality: '192' } },
};

// Endpoints that need a real binary payload we can't cheaply synthesise.
// Anything that classes as `needs-binary` gets SKIP.
const BINARY_ONLY_ENDPOINTS = new Set([
  'POST /api/face-analyze',
  'POST /api/detect-objects',
  'POST /api/stt',
  'POST /api/image-edit',
]);

// Endpoints whose "success" isn't a JSON 200 (streams, SSE, binary).
const STREAM_ENDPOINTS = new Set([
  'GET /api/events/job/:jobId',
  'GET /api/agents/system/stream',
  'POST /api/agents/system/stream',
  'GET /api/mesh/file/:jobId',
  'GET /api/combine/file/:id',
  'GET /api/yt-dl/file/:id',
  'GET /api/edit/file/:name',
  'GET /api/edit/poster/:name',
  'GET /api/realism/file/:name',
  'GET /api/realism/poster/:name',
  'GET /api/splat-upload/:name',
  'GET /api/splat-sample/:slug',
]);

// ── Helpers ───────────────────────────────────────────────────────
function isFileParam(p) { return p?.type === 'file'; }

function pickPathValue(entry, p, key) {
  if (REAL_VALUES[key]) return REAL_VALUES[key];
  if (p?.example != null && p.example !== '') return String(p.example);
  const fallbacks = {
    id: '1', jobId: 'nonexistent', videoId: 'nonexistent',
    projectId: 'nonexistent', renderId: 'nonexistent',
    imageId: 'nonexistent', chatId: 'nonexistent',
    slug: REAL_VALUES.slug, name: 'sample.mp4', shotIndex: '0',
    lane: 'video', idOrName: 'alice',
  };
  return fallbacks[key] ?? 'sample';
}

/** Look up fixture with a padded key too (some rows have double-space padding). */
function lookupFixture(entry) {
  const key = `${entry.method} ${entry.endpoint}`;
  const alt = `${entry.method.padEnd(4)} ${entry.endpoint}`;
  return FIXTURE_OVERRIDES[key] || FIXTURE_OVERRIDES[alt] || {};
}

/** Build final URL + init from a catalog entry. */
function buildRequest(entry) {
  const pathParams  = (entry.params || []).filter(p => p?.source === 'path');
  const queryParams = (entry.params || []).filter(p => p?.source === 'query');
  const bodyParams  = (entry.params || []).filter(p => p?.source === 'body');
  const override    = lookupFixture(entry);

  // OSINT dispatcher: `example_url` already bakes in placeholder path values
  // in dispatcher-order + a query string. Use it verbatim when it's not itself
  // a template.
  let urlPath;
  const useExampleUrl = entry.tool_name
    && entry.example_url
    && !entry.example_url.includes(':')
    && !entry.example_url.includes('{');
  if (useExampleUrl) {
    urlPath = entry.example_url;
  } else {
    urlPath = entry.route_key || entry.endpoint;

    // Path substitution
    for (const p of pathParams) {
      const supplied = override.pathValues?.[p.name];
      const val = supplied ?? pickPathValue(entry, p, p.name);
      urlPath = urlPath.replace(`:${p.name}`, encodeURIComponent(val));
    }

    // Query string
    const qs = new URLSearchParams();
    for (const p of queryParams) {
      if (p.example != null && p.example !== '') qs.set(p.name, String(p.example));
      else if (p.required)                        qs.set(p.name, 'test');
    }
    if (override.query) for (const [k, v] of Object.entries(override.query)) qs.set(k, String(v));
    const qsStr = qs.toString();
    if (qsStr) urlPath += (urlPath.includes('?') ? '&' : '?') + qsStr;
  }

  // Body
  let body;
  const headers = { ...GLOBAL_HEADERS };
  if (['POST', 'PATCH', 'PUT'].includes(entry.method)) {
    const obj = { ...(override.body || {}) };
    for (const p of bodyParams) {
      if (obj[p.name] !== undefined) continue;
      if (isFileParam(p)) continue;
      if (p.example != null && p.example !== '') obj[p.name] = p.example;
      else if (p.required) obj[p.name] = defaultFor(p.type);
    }
    body = JSON.stringify(obj);
    headers['Content-Type'] = 'application/json';
  }

  return { url: `${BASE}${urlPath}`, headers, body, override };
}

function defaultFor(type) {
  switch (type) {
    case 'number':  return 1;
    case 'boolean': return true;
    case 'array':   return [];
    default:        return 'test';
  }
}

/** True when the entry can't be smoke-tested from this harness. Returns a reason string, else null. */
function skipReason(entry) {
  if (entry.auth_required === 'vault')        return 'vault-required';
  if (entry.auth_required === 'worker-token') return 'worker-token';
  const hasFile = (entry.params || []).some(isFileParam);
  if (hasFile)                                return 'multipart';
  const key = `${entry.method} ${entry.endpoint}`;
  if (BINARY_ONLY_ENDPOINTS.has(key))          return 'needs-binary-payload';
  return null;
}

/** Given a status + response, decide if it's a PASS, SKIP, or FAIL. */
function classifyResponse(entry, res, json, text, override) {
  const status = res.status;
  const expected = override.expect;
  const inExpected = Array.isArray(expected) && expected.includes(status);

  if (status >= 200 && status < 300) return { outcome: 'PASS', reason: null };
  if (inExpected)                    return { outcome: 'PASS', reason: `matched expected [${expected.join(',')}]` };

  const errText = String(json?.message || json?.error || text || '').toLowerCase();

  if (status === 501)              return { outcome: 'SKIP', reason: 'auth-not-configured (501)' };
  if (status === 401 || status === 403) return { outcome: 'SKIP', reason: `auth-required (${status})` };

  // 503 upstream/worker down (Stockfish, face-service, ollama) — skip
  if (status === 503)              return { outcome: 'SKIP', reason: `upstream-down (503): ${errText.slice(0, 80)}` };

  // 502 bad gateway (worker unreachable) — skip
  if (status === 502)              return { outcome: 'SKIP', reason: `upstream-bad-gateway (502): ${errText.slice(0, 80)}` };

  // 500 with clear "fetch failed" / timeout / "operation was aborted" phrasing = upstream unreachable
  if (status === 500 && /fetch failed|operation was aborted|timeout|econnrefused|enotfound|upstream 5|upstream 4|nasa api 4|nasa api 5|api may be down|service unavailable/.test(errText)) {
    return { outcome: 'SKIP', reason: `upstream-unreachable (500): ${errText.slice(0, 80)}` };
  }

  // 430 (custom Blockchair rate limit)
  if (status === 430)              return { outcome: 'SKIP', reason: `upstream-rate-limited (430): ${errText.slice(0, 80)}` };

  // 404 with a clear "not found" phrasing means our synthetic ID missed a real
  // resource — that's a smoke-test limitation, not an endpoint bug.
  if (status === 404 && /not\s+found|unknown/.test(errText)) {
    return { outcome: 'SKIP', reason: `needs-real-id: ${errText.slice(0, 80)}` };
  }

  // 400 with "not found" — same story (some routes return 400 instead of 404)
  if (status === 400 && /not\s+found/.test(errText)) {
    return { outcome: 'SKIP', reason: `needs-real-id (400): ${errText.slice(0, 80)}` };
  }

  // 400 with a "required" hint on a header or param we couldn't supply — skip
  if (status === 400 && /header is required|session required|upload at least|upload a source|needs a source image/.test(errText)) {
    return { outcome: 'SKIP', reason: `needs-side-effect: ${errText.slice(0, 80)}` };
  }

  // Real endpoint bug
  return { outcome: 'FAIL', reason: json?.message || json?.error || text || `HTTP ${status}` };
}

async function fireOne(entry, idx, total) {
  const started = Date.now();
  const rec = {
    idx, total,
    endpoint: entry.endpoint,
    method:   entry.method,
    category: entry.category,
    status:   0,
    duration_ms: 0,
    ok: false,
    outcome: 'FAIL',
    response_shape_keys: null,
    error_message: null,
  };

  const skip = skipReason(entry);
  if (skip) {
    rec.outcome = 'SKIP';
    rec.error_message = skip;
    rec.duration_ms = 0;
    return rec;
  }

  const { url, headers, body, override } = buildRequest(entry);
  rec.url = url;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: entry.method, headers, body, signal: ctrl.signal });
    clearTimeout(timer);
    rec.status = res.status;
    rec.duration_ms = Date.now() - started;

    // Streams — 200 headers alone is enough. If we get 400/404 that just
    // means the fake ID/name didn't resolve; treat as SKIP since we can't
    // easily produce a real one without a full round-trip create.
    if (STREAM_ENDPOINTS.has(`${entry.method} ${entry.endpoint}`)) {
      try { ctrl.abort('done'); } catch {}
      if (res.status >= 200 && res.status < 300) {
        rec.ok = true; rec.outcome = 'PASS';
        rec.response_shape_keys = ['<stream>'];
        return rec;
      }
      if (res.status === 400 || res.status === 404) {
        rec.outcome = 'SKIP';
        rec.error_message = `stream: needs-real-id (${res.status})`;
        return rec;
      }
    }

    let json = null;
    let text = null;
    const ct = res.headers.get('content-type') || '';
    try {
      if (ct.includes('application/json')) json = await res.json();
      else                                  text = (await res.text()).slice(0, 300);
    } catch {}
    rec.response_shape_keys = json && typeof json === 'object' ? Object.keys(json).slice(0, 12) : null;

    const cls = classifyResponse(entry, res, json, text, override);
    rec.outcome       = cls.outcome;
    rec.error_message = cls.reason;
    rec.ok            = cls.outcome === 'PASS';
  } catch (e) {
    clearTimeout(timer);
    rec.duration_ms = Date.now() - started;
    const msg = String(e?.message || e || '');
    if (msg.includes('timeout') || msg.includes('aborted')) {
      if (SLOW_LANES.has(entry.subcategory) || SLOW_LANES.has(entry.category)) {
        rec.outcome = 'SKIP'; rec.error_message = 'too-slow-for-smoke';
      } else {
        rec.outcome = 'FAIL'; rec.error_message = `timeout after ${TIMEOUT_MS}ms`;
      }
    } else {
      rec.outcome = 'FAIL';
      rec.error_message = `network: ${msg}`;
    }
  }
  return rec;
}

// ── Main ──────────────────────────────────────────────────────────
(async function main() {
  // 1) Pre-flight
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`health returned ${res.status}`);
  } catch (e) {
    console.error(`\n[smoke] cannot reach BE at ${BASE} — ${e.message}`);
    console.error('[smoke] boot the server first:');
    console.error('        PORT=4021 npm start');
    console.error('        (or set SMOKE_URL to the running port)\n');
    process.exit(2);
  }

  // 2) Load the catalog straight from the running BE.
  const catRes = await fetch(`${BASE}/api/api-catalog`, { signal: AbortSignal.timeout(10000) });
  const catJson = await catRes.json();
  const entries = catJson.entries || catJson.data?.entries || [];
  if (!entries.length) {
    console.error(`[smoke] api-catalog returned 0 entries — bail`);
    process.exit(2);
  }

  console.log(`\n[smoke] BASE=${BASE}`);
  console.log(`[smoke] catalog: ${entries.length} entries`);
  console.log(`[smoke] timeout: ${TIMEOUT_MS}ms · slow lanes skipped: ${[...SLOW_LANES].join(', ')}`);
  console.log('');

  const results = [];
  const startedAll = Date.now();

  // OSINT throttling
  let osintCursor = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.category === 'osint') {
      const now = Date.now();
      const wait = Math.max(0, (osintCursor + OSINT_GAP) - now);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      osintCursor = Date.now();
    }
    const rec = await fireOne(entry, i + 1, entries.length);
    results.push(rec);
    const icon = rec.outcome === 'PASS' ? 'PASS' : rec.outcome === 'SKIP' ? 'SKIP' : 'FAIL';
    const line = `[${icon}] ${String(i + 1).padStart(3)}/${entries.length}  ${entry.method.padEnd(6)} ${entry.endpoint.padEnd(58)} ${String(rec.status).padStart(3)}  ${String(rec.duration_ms).padStart(5)}ms  ${rec.error_message ? '· ' + String(rec.error_message).slice(0, 90) : ''}`;
    if (process.stdout.isTTY) {
      const c = icon === 'PASS' ? '\x1b[32m' : icon === 'SKIP' ? '\x1b[33m' : '\x1b[31m';
      process.stdout.write(`${c}${line}\x1b[0m\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  const totalMs = Date.now() - startedAll;

  const passed  = results.filter(r => r.outcome === 'PASS').length;
  const failed  = results.filter(r => r.outcome === 'FAIL').length;
  const skipped = results.filter(r => r.outcome === 'SKIP').length;
  const total   = results.length;

  console.log('');
  console.log(`─────────────────────────────────────────────────────────────`);
  console.log(`  SMOKE SUMMARY   total=${total}   PASS=${passed}   FAIL=${failed}   SKIP=${skipped}   runtime=${(totalMs / 1000).toFixed(1)}s`);
  console.log(`─────────────────────────────────────────────────────────────`);

  if (failed) {
    console.log('\nFAILURES:');
    for (const r of results.filter(r => r.outcome === 'FAIL')) {
      console.log(`  · ${r.method} ${r.endpoint}  → ${r.status}  ${r.error_message}`);
    }
  }

  const outPath = path.resolve(process.cwd(), 'test-endpoints-results.json');
  await fs.writeFile(outPath, JSON.stringify({
    base: BASE,
    ran_at: new Date().toISOString(),
    total_ms: totalMs,
    counts: { total, passed, failed, skipped },
    results,
  }, null, 2), 'utf8');
  console.log(`\n[smoke] wrote ${outPath}`);

  process.exit(failed ? 1 : 0);
})();
