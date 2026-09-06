// services/osint/_common.js — shared helpers for every OSINT tool.
//
// Every tool file exports `default { name, description, paramSchema, needsKey?,
// run(params, query) }`. `run` returns raw data (JSON-serializable). Errors
// throw — the controller wraps in a 502 by default, or 501 if `needsKey` is
// missing (checked before invocation).
//
// The whole point of splitting each tool into its own file is so we can
// register them into a Map + auto-render them on the FE by their paramSchema.

const UA = 'siddharthfulia.com (eng@getpassionfruit.com)';

// Small module-local cache. 5-minute TTL by default. Keyed by
// `${toolName}:${JSON.stringify(params)}`. Cleared on PM2 restart.
const CACHE = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Accept: 'application/json', 'User-Agent': UA, ...(opts.headers || {}) },
    signal: opts.signal ?? AbortSignal.timeout(15000),
  });
  const contentType = res.headers.get('content-type') || '';
  let body;
  try {
    body = contentType.includes('application/json') || contentType.includes('dns-json')
      ? await res.json()
      : await res.text();
  } catch { body = null; }
  if (!res.ok) {
    const err = new Error(`upstream ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && hit.expiresAt > now) return hit.payload;
  const payload = await loader();
  CACHE.set(key, { expiresAt: now + (ttlMs ?? DEFAULT_TTL_MS), payload });
  return payload;
}

// Shape validation helper — throw a 400-ish error if the caller left a slot
// empty. The controller converts our thrown errors → HTTP status.
export function required(val, name) {
  const s = String(val ?? '').trim();
  if (!s) {
    const e = new Error(`${name} is required`);
    e.status = 400;
    throw e;
  }
  return s;
}

// paramSchema — small JSON-Schema-lite shape that the FE reads to auto-render
// input fields. Each field: { key, label, type, placeholder, helper, required }.
// Keep it short and human — this is what shows up as helper text below the
// input on the FE.
