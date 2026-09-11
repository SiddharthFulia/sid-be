// Sandboxed code execution proxy — powers the "Run" button on the
// /algorithms/* pages. We proxy to a public Piston instance so the
// upstream URL never leaks to the browser and we can enforce our own
// rate-limit + short-circuit repeat runs from a shared cache.
//
// Piston v1 (https://emkc.org/api/v1/piston/execute) response shape:
//   { ran: bool, language, version, output, stdout, stderr }
// v1 doesn't return an exit code or memory usage. `ran === true` means
// the compile step succeeded AND the program was executed at least
// once; a non-empty stderr with ran=true → runtime problem. `ran =
// false` → compile / build failure. We normalise both into a
// consistent shape for the FE.
//
// Design notes:
//   • Upstream URL kept ONLY in this file — never in a response body.
//   • In-memory rate limit is naive (single-process). PM2 cluster mode
//     is not used for sid-be right now; if we ever add it we'll swap
//     for Redis or move the limiter into rabbitmq.
//   • Cache key = sha256(language + code + stdin), 15 min TTL. Repeat
//     runs of the same code (very common while a user is scrolling
//     through the page) hit the cache and never touch Piston.
//   • Every failure path returns the same JSON envelope the success
//     path uses — the FE only has to look at `ok`.

import crypto from 'crypto';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';

// ─── Upstream endpoint (kept off the wire to the browser) ─────
const PISTON_URL = 'https://emkc.org/api/v1/piston/execute';

// ─── Limits ───────────────────────────────────────────────────
const MAX_SOURCE_BYTES  = 20 * 1024;        // 20 KB source cap
const MAX_STDIN_BYTES   = 4 * 1024;         // 4 KB stdin cap
const RUN_TIMEOUT_MS    = 5_000;            // 5 s runtime budget
const COMPILE_TIMEOUT_MS = 15_000;          // 15 s compile budget
const UPSTREAM_TIMEOUT_MS = 25_000;         // hard AbortController wall
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;  // 256 MB — enforced upstream

// ─── Whitelist ────────────────────────────────────────────────
// Piston v1 language slugs. `pseudo` is intercepted before we get to
// upstream — pseudocode is meant to be read, not executed.
const LANGUAGES = new Set(['c', 'cpp', 'python', 'java', 'rust']);

// ─── Rate limit ───────────────────────────────────────────────
// 10 requests per IP per rolling 60s window. Map<ip, timestamps[]>.
// The array is trimmed on every hit so it doesn't grow forever.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 10;
const rateLog = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (rateLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateLog.set(ip, hits);
    return true;
  }
  hits.push(now);
  rateLog.set(ip, hits);
  return false;
}

// ─── Result cache ─────────────────────────────────────────────
// SHA-256(language + '\0' + code + '\0' + stdin) → { at, payload }.
// 15 min TTL. Cheap in-memory Map; the LRU-ish sweep runs whenever a
// new key is written and there are more than 500 entries.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX    = 500;
const cache = new Map();
function cacheKey(language, code, stdin) {
  const h = crypto.createHash('sha256');
  h.update(language, 'utf8');
  h.update('\0');
  h.update(code, 'utf8');
  h.update('\0');
  h.update(stdin || '', 'utf8');
  return h.digest('hex');
}
function cacheGet(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() - row.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return row.payload;
}
function cacheSet(key, payload) {
  cache.set(key, { at: Date.now(), payload });
  if (cache.size > CACHE_MAX) {
    // Drop the oldest ~10% so we don't do a full O(n) scan every write.
    const drop = Math.floor(CACHE_MAX * 0.1);
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++i >= drop) break;
    }
  }
}

// ─── Piston call ──────────────────────────────────────────────
// Returns the normalised { ok, stdout, stderr, exit_code, compile_output,
// runtime_ms, cached } shape. Never throws — upstream faults come back
// as { ok: false, stderr: 'Code execution is temporarily unavailable' }.
async function callPiston({ language, code, stdin }) {
  const started = Date.now();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(PISTON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language,
        source: code,
        stdin: stdin || '',
      }),
      signal: controller.signal,
    });
    clearTimeout(abortTimer);
    if (!res.ok) {
      logger.warn(`Code exec upstream returned ${res.status}`);
      return {
        ok: false,
        stdout: '',
        stderr: 'Code execution is temporarily unavailable. Please try again shortly.',
        exit_code: null,
        compile_output: '',
        runtime_ms: Date.now() - started,
        upstream_status: res.status,
      };
    }
    const body = await res.json();
    // v1 shape → { ran, language, version, output, stdout, stderr }
    // We synthesise an exit_code:
    //   ran === true   → 0 (successful run — non-empty stderr is a
    //                      runtime warning, still exit 0 unless we know
    //                      otherwise)
    //   ran === false  → 1 (build failed)
    // If stderr is non-empty AND ran, we surface exit_code = null so the
    // FE tab colour stays neutral instead of flashing green on a runtime
    // error that Piston couldn't classify.
    const ran = body?.ran === true;
    const stderr = String(body?.stderr || '');
    const stdout = String(body?.stdout || '');
    let exit_code = ran ? 0 : 1;
    if (ran && stderr.trim()) exit_code = null;
    return {
      ok: true,
      stdout,
      stderr,
      exit_code,
      compile_output: ran ? '' : stderr,
      runtime_ms: Date.now() - started,
      version: body?.version || null,
    };
  } catch (err) {
    clearTimeout(abortTimer);
    const aborted = err?.name === 'AbortError';
    logger.warn(`Code exec upstream failed: ${aborted ? 'timeout' : err.message}`);
    return {
      ok: false,
      stdout: '',
      stderr: aborted
        ? 'Timed out waiting for the sandbox. Try a smaller input or fewer loops.'
        : 'Code execution is temporarily unavailable. Please try again shortly.',
      exit_code: null,
      compile_output: '',
      runtime_ms: Date.now() - started,
    };
  }
}

// ─── Controller ───────────────────────────────────────────────
// POST /api/code/run  { language, code, stdin? }
// Response envelope:
//   { ok, stdout, stderr, exit_code, compile_output, runtime_ms, cached, language }
// Non-2xx statuses reserved for validation / rate-limit / upstream 502.
export const postCodeRun = async (req, res) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (rateLimited(ip)) {
      return error(res, 'Too many runs — try again in a minute.', 429);
    }

    let { language, code, stdin } = req.body || {};
    language = String(language || '').toLowerCase().trim();
    code     = String(code || '');
    stdin    = String(stdin || '');

    if (!language) return error(res, 'language is required', 400);
    if (!code || !code.trim()) return error(res, 'code is required', 400);

    // Pseudo-code is documentation, not a program. Return a friendly
    // 400 the FE can flip into a helpful tooltip.
    if (language === 'pseudo') {
      return error(res, 'Pseudo-code is not runnable — pick C, C++, Python, Java, or Rust.', 400);
    }
    if (!LANGUAGES.has(language)) {
      return error(res, `Unsupported language: ${language}`, 400);
    }
    if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_BYTES) {
      return error(res, `Source too large — max ${MAX_SOURCE_BYTES / 1024} KB`, 413);
    }
    if (Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES) {
      return error(res, `Stdin too large — max ${MAX_STDIN_BYTES / 1024} KB`, 413);
    }

    const key = cacheKey(language, code, stdin);
    const hit = cacheGet(key);
    if (hit) {
      logger.info(`CODE RUN | ${language} | cache-hit | ${ip}`);
      return success(res, { ...hit, cached: true });
    }

    const upstream = await callPiston({ language, code, stdin });
    if (!upstream.ok) {
      // Don't cache failures — the sandbox may come back in a few
      // seconds. FE renders `stderr` as the friendly message.
      return res.status(upstream.upstream_status && upstream.upstream_status >= 500 ? 502 : 502)
        .json({
          status: false,
          message: upstream.stderr,
          data: {
            stdout: '',
            stderr: upstream.stderr,
            exit_code: null,
            compile_output: '',
            runtime_ms: upstream.runtime_ms,
            cached: false,
            language,
          },
        });
    }

    const payload = {
      stdout: upstream.stdout,
      stderr: upstream.stderr,
      exit_code: upstream.exit_code,
      compile_output: upstream.compile_output,
      runtime_ms: upstream.runtime_ms,
      language,
      version: upstream.version,
      limits: {
        run_timeout_ms: RUN_TIMEOUT_MS,
        compile_timeout_ms: COMPILE_TIMEOUT_MS,
        memory_bytes: MEMORY_LIMIT_BYTES,
        source_bytes: MAX_SOURCE_BYTES,
      },
    };
    cacheSet(key, payload);
    logger.info(`CODE RUN | ${language} | exit=${payload.exit_code ?? 'x'} | ${payload.runtime_ms}ms | ${ip}`);
    return success(res, { ...payload, cached: false });
  } catch (err) {
    logger.error('Code run failed', err?.message);
    // Never leak internal stack traces
    return error(res, 'Code execution is temporarily unavailable. Please try again shortly.', 502);
  }
};
