// Pathfinding — AI recommendation controller.
//
// POST /api/pathfinding/recommend  { city, query }
//   → { ok, recommendations: [{ name, kind, reason, area,
//                               rating?, price?, url?, walking_minutes? }],
//       sources: [url, url, ...], model, used_web_search, cached }
//
// The FE Pathfinding lab lets the user describe what they're looking for
// in plain English ("italian restaurant in bandra") and gets back 3-5
// real place suggestions. These are hints only — the FE then matches
// each name against the city_places table via the existing fuzzy search
// endpoint, or falls back to Nominatim geocoding if no match.
//
// Primary model: `groq/compound` — Groq's agentic model with a built-in
// web search + code execution tool. It searches the live web before
// answering, so recommendations are for actually-current places (rather
// than the pure-LLM's training-data snapshot which may reference closed
// or renamed venues). Fallback: `openai/gpt-oss-120b` (pure LLM, no
// search) for when compound is rate-limited, 413's (search payload too
// large for the internal Scout model's TPM cap), or 5xx's. Optional
// `?model=` query overrides the primary model against a small
// allowlist.
//
// Compound uses `search_settings.include_domains` scoped to review /
// listing sites (Zomato, TimeOut, TripAdvisor, LBB, etc). Without this,
// compound fetches whatever the top Google results are and blows past
// the free tier's 30k TPM cap on the internal `llama-4-scout` model
// (verified empirically — see COMPOUND_SEARCH_DOMAINS).
//
// Cache: (city, query) → { recommendations, sources, used_web_search },
// 6h TTL (compound is ~4× more expensive than pure LLM — worth keeping
// warm longer). Rate limit: 5 req/min/IP (tighter than the old 10 for
// the same reason). Both 429 responses set a Retry-After header.

import { GROQ_API_KEY } from '../../helpers/constants.js';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Timeout for a single Groq call. Compound with web search typically
// takes 3-8s (search + tool call round-trip + generation). We give it
// 30s of headroom for the primary attempt; the fallback pure-LLM call
// is cheap so shares the same budget.
const GROQ_TIMEOUT_MS = 30 * 1000;

// Groq's `compound` model runs its own web-search tool and inlines the
// fetched page content into its INTERNAL model's prompt. Without a
// domain allow-list the aggregated content routinely exceeds the free
// tier's 30k TPM cap on `llama-4-scout` and the request 413/429's.
// Scoping to a curated list of place-review sites both keeps the search
// output focused (better recommendations, less marketing fluff) and
// keeps the token count manageable. Anything the model finds off this
// list still gets summarised in the reply — the domains only bound the
// pages it will fetch full content from.
const COMPOUND_SEARCH_DOMAINS = [
  'zomato.com',
  'timeout.com',
  'tripadvisor.com',
  'tripadvisor.in',
  'google.com',
  'lbb.in',
  'conde-nast-traveller.in',
  'condenasttraveler.com',
  'thehindu.com',
  'thebetterindia.com',
  'magicpin.com',
  'swiggy.com',
];

// ── In-memory cache (6h TTL) ──
// Map<`${model}::${citySlug}::${normalizedQuery}`,
//     { data: { recommendations, sources, used_web_search, model }, expiresAt }>
const CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
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

// ── Rate limiter (naive per-IP, 5 req/min) ──
// Tighter than the old 10 because each compound call is ~4× more
// expensive on Groq (search tool round-trips + longer generation).
// Map<ip, number[]> = timestamps of recent hits within the window.
const RATE_LIMIT_MAX = 5;
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

// ── Prompts ──
// Compound has a built-in web-search tool the model can invoke. We
// steer it hard toward using the search — the whole point of routing to
// compound (vs pure LLM) is to get current, verified places rather than
// training-data recall. We also allow rich per-place fields (url,
// walking_minutes) that the search naturally surfaces.
const buildCompoundSystem = (city) => `You are a local guide for ${city}. Search the web for current, real places matching the user's query. Only return places that are currently operating — cross-check against recent reviews or listings.

Return 3-5 recommendations. For each place, include:
  name             — verified official/common name (string)
  kind             — restaurant | cafe | park | mall | hospital | landmark | museum | hotel | bar | etc (string)
  reason           — one line, under 100 chars, explaining why THIS place vs alternatives. Cite a rating, a specific dish, a defining detail — not generic marketing.
  area             — neighbourhood/area name within ${city} (string)
  rating           — 1-5 float if you found one in your search results, else null
  price            — "$" | "$$" | "$$$" | "$$$$" | null
  url              — reference URL from your search (Google Maps, Zomato, official site, listing), else null
  walking_minutes  — integer if the query implies a walking radius or the source stated one, else null

Respond with ONLY a JSON array — no prose, no citations block, no markdown fences, no commentary before or after. The very first character of your reply must be '['.`;

// Pure-LLM fallback prompt (no search tool available). Explicit
// "well-known" language nudges the model to recall famous venues rather
// than invent. We still allow rich fields but the LLM path will
// typically leave url and walking_minutes null.
const buildLlmSystem = (city) => `You are a local guide for ${city}. Given a query, return 3-5 real place recommendations as strict JSON.

Fields per place:
  name             — official/common name (string)
  kind             — restaurant | cafe | park | mall | hotel | hospital | museum | etc (string)
  reason           — one line, under 100 chars, why this place
  area             — neighbourhood name within ${city} (string)
  rating           — null (you cannot verify without web search)
  price            — "$" | "$$" | "$$$" | "$$$$" | null
  url              — null (you cannot verify)
  walking_minutes  — null

Only well-known real places — do not fabricate. Respond ONLY with a JSON array, no markdown, no code fence, no prose.`;

const buildRetryLlmSystem = (city) => `You MUST respond with ONLY a JSON array. No prose. No markdown. No code fences. You are a local guide for ${city}. Return 3-5 real place recommendations. Schema: [{"name":"...","kind":"restaurant|cafe|park|mall|hotel|hospital|museum|...","reason":"one line, <100 chars","area":"neighbourhood name","rating":null,"price":null,"url":null,"walking_minutes":null}]. Only real places — never invented. Output the raw JSON array and nothing else.`;

// ── JSON extraction ──
// Best-effort JSON extraction. Groq's compound sometimes leaks its
// reasoning trace, tool-call annotations, or a preamble ("Based on my
// search…") ahead of the JSON. Also wraps in ```json fences even when
// told not to. This pulls the first well-formed [ ... ] block out.
function extractJsonArray(text) {
  if (!text || typeof text !== 'string') return null;
  let trimmed = text.trim();

  // Strip common preambles compound loves to prepend.
  trimmed = trimmed
    .replace(/^\s*(here\s+(are|is)|based\s+on|i\s+searched|after\s+searching|according\s+to)[^[]*?(?=\[)/i, '')
    .trim();

  try {
    const p = JSON.parse(trimmed);
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.recommendations)) return p.recommendations;
    if (p && Array.isArray(p.places)) return p.places;
    if (p && Array.isArray(p.results)) return p.results;
  } catch { /* fall through */ }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const p = JSON.parse(fenced[1].trim());
      if (Array.isArray(p)) return p;
      if (p && Array.isArray(p.recommendations)) return p.recommendations;
      if (p && Array.isArray(p.places)) return p.places;
      if (p && Array.isArray(p.results)) return p.results;
    } catch { /* fall through */ }
  }

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

// Normalise one entry into the response schema. Drops anything that
// clearly isn't a place. Clamps string lengths so a rogue model can't
// blow up the FE render. Optional fields (rating, price, url,
// walking_minutes) are omitted rather than set to null so the FE can
// simply check truthiness.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 120);
  if (!name) return null;
  const kind = String(raw.kind || raw.type || 'place').trim().toLowerCase().slice(0, 40) || 'place';
  const reason = String(raw.reason || raw.why || '').trim().slice(0, 200);
  const area = String(raw.area || raw.neighbourhood || raw.neighborhood || raw.locality || '').trim().slice(0, 80);

  const out = { name, kind, reason, area };

  // Rating: accept number 1-5, string "4.4", or null. Clamp to [1, 5].
  const rawRating = raw.rating ?? raw.stars ?? raw.score;
  if (rawRating != null && rawRating !== '') {
    const n = Number(rawRating);
    if (Number.isFinite(n) && n > 0 && n <= 5) out.rating = Math.round(n * 10) / 10;
  }

  // Price: accept "$", "$$", "$$$", "$$$$", or null. Anything else → skip.
  const rawPrice = String(raw.price ?? raw.priceRange ?? '').trim();
  if (/^\${1,4}$/.test(rawPrice)) out.price = rawPrice;

  // URL: must be http(s), reasonable length.
  const rawUrl = String(raw.url || raw.link || raw.href || raw.website || '').trim();
  if (/^https?:\/\/\S+$/i.test(rawUrl) && rawUrl.length <= 500) out.url = rawUrl;

  // Walking minutes: positive integer, capped at 120 (2h walk is
  // absurd for a city recommendation).
  const rawWalk = raw.walking_minutes ?? raw.walk_minutes ?? raw.walkingMinutes ?? raw.walk_time;
  if (rawWalk != null && rawWalk !== '') {
    const n = Number(rawWalk);
    if (Number.isFinite(n) && n > 0 && n <= 120) out.walking_minutes = Math.round(n);
  }

  return out;
}

// Normalise + de-dupe sources into a compact list of clean http(s) URLs.
function normalizeSources(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    // Sources may come as strings or { url, title } objects.
    const url = typeof raw === 'string' ? raw : (raw?.url || raw?.link || raw?.href);
    if (!url || typeof url !== 'string') continue;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 8) break;
  }
  return out;
}

// Pull citation URLs from Groq's compound response. The shape has shifted
// a couple of times in Groq's beta — check every field we've observed:
//   • data.search_results                           (older shape)
//   • data.choices[0].message.search_results        (mid)
//   • data.choices[0].message.citations             (mid)
//   • data.choices[0].message.executed_tools[].{search_results, output}
//                                                   (current agentic shape)
// The `output` field on an executed_tool is often a JSON-encoded string,
// so we try to parse it and pull nested results / citations.
function extractSourcesFromCompound(data) {
  const urls = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'string') urls.push(v);
    else if (typeof v === 'object') {
      // Prefer canonical URL fields; ignore other keys.
      const u = v.url || v.link || v.href;
      if (u) urls.push(u);
    }
  };

  // Top-level search_results (older shape).
  push(data?.search_results);

  const msg = data?.choices?.[0]?.message;
  if (msg) {
    push(msg.search_results);
    push(msg.citations);
    if (Array.isArray(msg.executed_tools)) {
      for (const tool of msg.executed_tools) {
        // Current agentic shape: search_results is an OBJECT with a
        // `results` array of { url, title, content } — not a bare array.
        const sr = tool?.search_results;
        if (sr && typeof sr === 'object' && !Array.isArray(sr)) {
          push(sr.results);
          push(sr.citations);
        } else {
          push(sr);
        }
        // Tool `output` can be a plain-text digest ("Title: ...\nURL: ...")
        // OR a JSON-encoded string of { results: [...] }. Try JSON first
        // then fall back to a regex scrape of URLs from the text.
        if (typeof tool?.output === 'string') {
          let parsed = null;
          try { parsed = JSON.parse(tool.output); } catch { /* not JSON */ }
          if (parsed) {
            push(parsed.results);
            push(parsed.search_results);
            push(parsed.citations);
          } else {
            // Scrape any http(s) URL from the digest text.
            const matches = tool.output.match(/https?:\/\/[^\s"'<>)]+/g);
            if (matches) matches.forEach((u) => urls.push(u));
          }
        } else if (tool?.output && typeof tool.output === 'object') {
          push(tool.output);
        }
      }
    }
  }

  return normalizeSources(urls);
}

// True if the response shows compound actually invoked a tool. We use
// this to set `used_web_search` on the response so the FE can subtly
// indicate "🌐 web-verified" vs "💭 from memory". We check both the
// presence of executed_tools AND that we actually extracted citation
// URLs — either signal on its own is a decent indicator.
function detectWebSearchUsed(data, sourceCount) {
  if (sourceCount > 0) return true;
  const tools = data?.choices?.[0]?.message?.executed_tools;
  if (Array.isArray(tools) && tools.length > 0) return true;
  return false;
}

// ── Direct Groq call ──
// Uses fetch directly instead of the shared services/groq.js helper so
// we can surface `search_results` / `executed_tools` — the shared helper
// flattens the response to just { reply }. Applies a hard abort timeout
// so a hanging Groq call can't stall the request beyond GROQ_TIMEOUT_MS.
async function callGroq({ model, system, user, temperature = 0.3, maxTokens = 2000, searchSettings = null }) {
  if (!GROQ_API_KEY) throw new Error('Groq API key not configured');

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  // Groq compound accepts an optional `search_settings` object to scope
  // its web-search tool. See COMPOUND_SEARCH_DOMAINS for why we bother.
  if (searchSettings) body.search_settings = searchSettings;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error(`Groq ${model} timed out after ${GROQ_TIMEOUT_MS}ms`);
      err.status = 504;
      throw err;
    }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody?.error?.message || `Groq API error: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  // Extract ONLY the content field. Compound sometimes returns a
  // sibling `reasoning` field with its internal thinking trace — we
  // deliberately ignore it (it's not JSON and would only confuse the
  // parser). Same for tool-call metadata which lives on executed_tools.
  return {
    reply: data?.choices?.[0]?.message?.content || '',
    model: data?.model || model,
    raw: data,
  };
}

const userMsg = (city, query) => `Query: ${query}\nCity: ${city}\nReturn the JSON array now.`;

// ── Attempt strategies ──
// Compound (with web search) — real current places + citation URLs.
async function tryCompound({ city, query, model }) {
  const res = await callGroq({
    model, // 'groq/compound' or 'groq/compound-mini'
    system: buildCompoundSystem(city),
    user: userMsg(city, query),
    // Compound's INTERNAL model (llama-4-scout on free tier) is capped
    // at 30k TPM. Web search alone adds ~14k tokens of context — a big
    // completion budget will trip 429 (rate_limit_exceeded on the
    // internal model). 1500 fits ~5 rich JSON objects comfortably.
    maxTokens: 1500,
    temperature: 0.2,
    searchSettings: { include_domains: COMPOUND_SEARCH_DOMAINS },
  });
  const sources = extractSourcesFromCompound(res.raw);
  return {
    items: extractJsonArray(res.reply),
    sources,
    model: res.model,
    usedWebSearch: detectWebSearchUsed(res.raw, sources.length),
  };
}

// Pure LLM fallback — gpt-oss-120b, no web search, no citations.
async function tryLlm({ city, query, model }) {
  const res = await callGroq({
    model, // 'openai/gpt-oss-120b' or 'openai/gpt-oss-20b'
    system: buildLlmSystem(city),
    user: userMsg(city, query),
    maxTokens: 2000,
    temperature: 0.3,
  });
  let items = extractJsonArray(res.reply);
  let modelOut = res.model;
  if (!items) {
    // One retry with a stricter prompt — pure-LLM models hallucinate
    // preambles ("Here are…") more often than compound.
    const retry = await callGroq({
      model,
      system: buildRetryLlmSystem(city),
      user: userMsg(city, query),
      maxTokens: 2000,
      temperature: 0.2,
    });
    items = extractJsonArray(retry.reply);
    modelOut = retry.model || modelOut;
  }
  return { items, sources: [], model: modelOut, usedWebSearch: false };
}

// Whitelist of models the FE is allowed to force via `?model=`. Anything
// else silently falls back to the default (compound). Keeps a hostile
// caller from routing us to an expensive tier.
const ALLOWED_MODEL_OVERRIDES = new Set([
  'groq/compound',
  'groq/compound-mini',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
]);

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

    // ── Model selection ──
    // Default to compound (web-search enabled). Query-param override lets
    // the FE force a specific model (e.g. compound-mini for speed, or
    // gpt-oss-120b to compare quality).
    const requestedModel = String(req.query?.model || '').trim().toLowerCase();
    const primaryModel = ALLOWED_MODEL_OVERRIDES.has(requestedModel)
      ? requestedModel
      : 'groq/compound';

    const cacheKey = `${primaryModel}::${city.toLowerCase()}::${query.toLowerCase()}`;

    const cached = cacheGet(cacheKey);
    if (cached) {
      logger.info(`PATHFIND RECOMMEND (cache) | city=${city} | q="${query.slice(0, 60)}"`);
      return success(res, {
        ok: true,
        recommendations: cached.recommendations,
        sources: cached.sources || [],
        model: cached.model || primaryModel,
        used_web_search: !!cached.used_web_search,
        cached: true,
      });
    }

    const start = Date.now();
    logger.info(`PATHFIND RECOMMEND | city=${city} | q="${query.slice(0, 60)}" | model=${primaryModel}`);

    // ── Attempt 1: primary model ──
    // If user forced a non-compound model, honour it directly through the
    // LLM path. Compound family goes through the search-aware path.
    let items = null;
    let sources = [];
    let modelUsed = primaryModel;
    let usedWebSearch = false;
    let primaryErr = null;

    const isCompoundFamily = primaryModel.startsWith('groq/compound');

    try {
      const out = isCompoundFamily
        ? await tryCompound({ city, query, model: primaryModel })
        : await tryLlm({ city, query, model: primaryModel });
      items = out.items;
      sources = out.sources;
      modelUsed = out.model || primaryModel;
      usedWebSearch = !!out.usedWebSearch;
      if (!items || !items.length) {
        throw new Error(`${primaryModel} returned no parseable list`);
      }
    } catch (e) {
      primaryErr = e;
      logger.warn(`recommend ${primaryModel} failed: ${e.message} — falling back`);
    }

    // ── Fallback: gpt-oss-120b (pure LLM, no search) ──
    // If compound was the primary and failed, drop to gpt-oss-120b. If
    // the primary WAS already gpt-oss-120b (via ?model= override) we
    // don't loop back to itself — bail with 502.
    if (!items || !items.length) {
      const fallbackModel = 'openai/gpt-oss-120b';
      if (primaryModel === fallbackModel) {
        // We can't drop to a fallback because it IS the fallback. Give
        // the caller a friendly 502 rather than leaking the raw Groq
        // error to the FE.
        logger.error(`recommend primary==fallback and failed: ${primaryErr?.message}`);
        return error(res, 'The recommender did not return a valid list — try rephrasing your query.', 502);
      }
      modelUsed = fallbackModel;
      try {
        const out = await tryLlm({ city, query, model: fallbackModel });
        items = out.items;
        sources = out.sources; // empty — no search on the LLM path
        modelUsed = out.model || fallbackModel;
        usedWebSearch = false;
      } catch (fallbackErr) {
        logger.error(`recommend fallback also failed: ${fallbackErr.message}`);
        // Both compound AND gpt-oss-120b failed — return a friendly 502.
        // 429/413 both mean "Groq refused because tier limits" — same UX.
        const primaryMsg = primaryErr?.message || '';
        const isThrottled = /429|rate\s*limit|Request Entity Too Large|413/i.test(primaryMsg)
          || /429|rate\s*limit|Request Entity Too Large|413/i.test(fallbackErr.message);
        if (isThrottled) {
          res.setHeader('Retry-After', '30');
          return error(res, 'The recommender is rate-limited by Groq right now — try again in 30s.', 429);
        }
        return error(res, 'The recommender is temporarily unavailable — please try again in a moment.', 502);
      }
    }

    // ── Attempt 3: last-ditch gpt-oss-20b with a stricter prompt ──
    // Compound flaked AND gpt-oss-120b returned an unparseable / empty
    // list. gpt-oss-20b is cheap + fast; give it one shot with the
    // stricter retry prompt before we give up.
    if (!items || !items.length) {
      const lastDitchModel = 'openai/gpt-oss-20b';
      if (primaryModel !== lastDitchModel) {
        try {
          const out = await tryLlm({ city, query, model: lastDitchModel });
          if (out.items && out.items.length) {
            items = out.items;
            sources = [];
            modelUsed = out.model || lastDitchModel;
            usedWebSearch = false;
          }
        } catch (e) {
          logger.warn(`recommend last-ditch ${lastDitchModel} failed: ${e.message}`);
        }
      }
    }

    // Still nothing — degrade gracefully. Return 200 with empty items
    // + a friendly `message` so the FE can render "no matches — try
    // rephrasing" inside the popover rather than a red error toast.
    if (!items || !items.length) {
      return success(res, {
        ok: false,
        recommendations: [],
        sources: [],
        model: modelUsed,
        used_web_search: false,
        cached: false,
        message: 'No recommendations for this query — try being more specific (e.g. "italian in bandra" or "coffee near powai").',
      });
    }

    // ── Normalise + trim to 5 ──
    const recommendations = items
      .map(normalizeEntry)
      .filter(Boolean)
      .slice(0, 5);

    if (!recommendations.length) {
      return error(res, 'No usable recommendations returned.', 502);
    }

    const finalSources = normalizeSources(sources);

    cacheSet(cacheKey, {
      recommendations,
      sources: finalSources,
      model: modelUsed,
      used_web_search: usedWebSearch,
    });
    logger.info(`PATHFIND RECOMMEND OK | ${Date.now() - start}ms | model=${modelUsed} | n=${recommendations.length} | sources=${finalSources.length} | web=${usedWebSearch}`);
    return success(res, {
      ok: true,
      recommendations,
      sources: finalSources,
      model: modelUsed,
      used_web_search: usedWebSearch,
      cached: false,
    });
  } catch (err) {
    logger.error(`Pathfinding recommend failed: ${err.message}`);
    return error(res, err.message);
  }
};

export default postRecommend;
