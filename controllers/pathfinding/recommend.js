// Pathfinding — AI recommendation controller.
//
// POST /api/pathfinding/recommend  { city, query }
//   → { ok, recommendations: [{ name, kind, reason, area }] }
//
// The FE Pathfinding lab lets the user describe what they're looking for
// in plain English ("italian restaurant in bandra") and gets back 3-5
// real place suggestions. These are hints only — the FE then matches
// each name against the city_places table via the existing fuzzy search
// endpoint, or falls back to Nominatim geocoding if no match.
//
// Model preference: `openai/gpt-oss-120b` for reasoning depth (knowing
// real neighbourhood-scoped places). Falls back to `openai/gpt-oss-20b`
// if the 120b model errors out. (Groq retired the llama-3.3-70b lane in
// late-2026 — gpt-oss-20b is the current small-fast fallback.) The strict
// JSON reply is parsed defensively — one retry with a stronger prompt
// on parse failure.
//
// Cache: (city, query) → recommendations, 1h TTL. Rate limit: 10 requests
// per IP per minute (naive in-memory Map keyed by req.ip).

import { chatGroq } from '../../services/groq.js';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';

// ── In-memory cache (1h TTL) ──
// Map<`${citySlug}::${normalizedQuery}`, { data, expiresAt }>
const CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 500;

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { CACHE.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) {
  if (CACHE.size >= MAX_CACHE) {
    // Naive eviction — drop the oldest 10%
    const drop = Math.ceil(MAX_CACHE * 0.1);
    let i = 0;
    for (const k of CACHE.keys()) {
      if (i++ >= drop) break;
      CACHE.delete(k);
    }
  }
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Rate limiter (naive per-IP, 10 req/min) ──
// Map<ip, number[]> = timestamps of recent hits within the window.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = (RATE_LIMIT.get(ip) || []).filter((t) => t >= cutoff);
  if (arr.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((arr[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfter };
  }
  arr.push(now);
  RATE_LIMIT.set(ip, arr);
  return { allowed: true };
}

// Periodic janitor — drop empty IP entries so the Map doesn't grow
// unbounded on a long-lived process. Runs every 5 minutes.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, arr] of RATE_LIMIT.entries()) {
    const filtered = arr.filter((t) => t >= cutoff);
    if (!filtered.length) RATE_LIMIT.delete(ip);
    else RATE_LIMIT.set(ip, filtered);
  }
}, 5 * 60 * 1000).unref?.();

// ── Prompt + parsing ──
const buildSystem = (city) => `You are a local guide for ${city}. Given a query, return 3-5 real place recommendations as strict JSON. Fields: name (string), kind (restaurant/cafe/park/mall/hotel/hospital/museum/etc), reason (one-line why, under 90 chars), area (neighbourhood name). Only real, well-known places — do not fabricate. Respond ONLY with a JSON array, no markdown, no code fence, no prose.`;

const buildRetrySystem = (city) => `You MUST respond with ONLY a JSON array. No prose. No markdown. No code fences. You are a local guide for ${city}. Return 3-5 real place recommendations. Schema: [{"name":"...","kind":"restaurant|cafe|park|mall|hotel|hospital|museum|...","reason":"one line, <90 chars","area":"neighbourhood name"}]. Only real places — never invented. Output the raw JSON array and nothing else.`;

// Best-effort JSON extraction. Groq occasionally wraps the array in
// ```json fences even when told not to, or preambles with "Here are…";
// this pulls the first [ ... ] block out of the reply.
function extractJsonArray(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Try direct parse first.
  try {
    const p = JSON.parse(trimmed);
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.recommendations)) return p.recommendations;
  } catch { /* fall through */ }
  // Strip common fences (```json ... ``` or ``` ... ```).
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const p = JSON.parse(fenced[1].trim());
      if (Array.isArray(p)) return p;
      if (p && Array.isArray(p.recommendations)) return p.recommendations;
    } catch { /* fall through */ }
  }
  // Grab first [...] block by depth walk.
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const slice = trimmed.slice(start, end + 1);
    try {
      const p = JSON.parse(slice);
      if (Array.isArray(p)) return p;
    } catch { /* give up */ }
  }
  return null;
}

// Normalise an entry into the response schema, dropping anything that
// clearly isn't a place. Also clamps string lengths so a rogue model
// can't blow up the FE render.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 120);
  if (!name) return null;
  const kind = String(raw.kind || raw.type || 'place').trim().toLowerCase().slice(0, 40) || 'place';
  const reason = String(raw.reason || raw.why || '').trim().slice(0, 140);
  const area = String(raw.area || raw.neighbourhood || raw.neighborhood || raw.locality || '').trim().slice(0, 80);
  return { name, kind, reason, area };
}

async function askGroq({ city, query, model, system }) {
  const userMsg = `Query: ${query}\nCity: ${city}\nReturn the JSON array now.`;
  // gpt-oss-* burns tokens on a hidden `reasoning` trace before emitting
  // the visible `content`. 900 ends up truncating the JSON on longer
  // queries — 2000 gives comfortable headroom without materially raising
  // latency (Groq is fast even at higher caps).
  const res = await chatGroq(userMsg, [], model, {
    system,
    maxTokens: 2000,
    temperature: 0.3,
  });
  return res?.reply || '';
}

export const postRecommend = async (req, res) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return error(res, `Too many requests — try again in ${rl.retryAfter}s`, 429);
    }

    const rawCity = String(req.body?.city || '').trim();
    const rawQuery = String(req.body?.query || '').trim();
    if (!rawCity) return error(res, 'city is required', 400);
    if (!rawQuery) return error(res, 'query is required', 400);
    if (rawQuery.length < 2) return error(res, 'query too short', 400);
    if (rawQuery.length > 300) return error(res, 'query too long (max 300)', 400);

    const city = rawCity.slice(0, 60);
    const query = rawQuery.slice(0, 300);
    const cacheKey = `${city.toLowerCase()}::${query.toLowerCase()}`;

    const cached = cacheGet(cacheKey);
    if (cached) {
      logger.info(`PATHFIND RECOMMEND (cache) | city=${city} | q="${query.slice(0, 60)}"`);
      return success(res, { ok: true, recommendations: cached, cached: true });
    }

    const start = Date.now();
    logger.info(`PATHFIND RECOMMEND | city=${city} | q="${query.slice(0, 60)}"`);

    // ── Attempt 1: gpt-oss-120b + primary system ──
    let reply = '';
    let modelUsed = 'openai/gpt-oss-120b';
    let primaryErr = null;
    try {
      reply = await askGroq({
        city, query, model: 'gpt-oss-120b', system: buildSystem(city),
      });
    } catch (e) {
      primaryErr = e;
      logger.warn(`recommend gpt-oss-120b failed: ${e.message} — falling back to gpt-oss-20b`);
    }

    // ── Fallback: openai/gpt-oss-20b ──
    // (Groq retired llama-3.3-70b-versatile in late-2026. gpt-oss-20b is
    //  the smaller/faster sibling that shares the 120b's JSON reliability.)
    if (!reply) {
      modelUsed = 'openai/gpt-oss-20b';
      try {
        reply = await askGroq({
          city, query, model: 'openai/gpt-oss-20b', system: buildSystem(city),
        });
      } catch (fallbackErr) {
        logger.error(`recommend fallback also failed: ${fallbackErr.message}`);
        const status = /429/.test(fallbackErr.message) ? 429 : 502;
        return error(res, primaryErr?.message || fallbackErr.message, status);
      }
    }

    // ── Parse ──
    let items = extractJsonArray(reply);

    // ── Retry once with a stronger prompt on parse failure ──
    if (!items) {
      logger.warn('recommend parse failed on first attempt — retrying with strict prompt');
      try {
        const retryReply = await askGroq({
          city, query,
          model: modelUsed === 'openai/gpt-oss-120b' ? 'gpt-oss-120b' : 'openai/gpt-oss-20b',
          system: buildRetrySystem(city),
        });
        items = extractJsonArray(retryReply);
      } catch (retryErr) {
        logger.warn(`recommend retry failed: ${retryErr.message}`);
      }
    }

    if (!items || !items.length) {
      return error(res, 'The recommender did not return a valid list — try rephrasing.', 502);
    }

    // ── Normalise + trim to 5 ──
    const recommendations = items
      .map(normalizeEntry)
      .filter(Boolean)
      .slice(0, 5);

    if (!recommendations.length) {
      return error(res, 'No usable recommendations returned.', 502);
    }

    cacheSet(cacheKey, recommendations);
    logger.info(`PATHFIND RECOMMEND OK | ${Date.now() - start}ms | model=${modelUsed} | n=${recommendations.length}`);
    return success(res, { ok: true, recommendations, model: modelUsed });
  } catch (err) {
    logger.error(`Pathfinding recommend failed: ${err.message}`);
    return error(res, err.message);
  }
};

export default postRecommend;
