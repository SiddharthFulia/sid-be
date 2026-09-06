// /osint/* — Free-tier OSINT / third-party API proxy.
//
// The BE calls these upstreams so:
//   • the FE avoids CORS pain
//   • API keys stay on the server
//   • we can add a small in-memory cache with per-endpoint TTLs
//
// Response shape mirrors the existing nasa proxy: on success we send the
// upstream JSON verbatim (so the FE can consume it directly). On upstream
// failure we return `{ error, status }` with the upstream HTTP code.
//
// Endpoints (all GET):
//   /earthquakes?window=hour|day|week|month  — USGS feed
//   /eonet?days=&limit=&category=            — NASA EONET open events
//   /weather-alerts                          — NOAA active alerts
//   /iss                                     — open-notify ISS position
//   /astros                                  — open-notify people in space
//   /satellites?group=active                 — CelesTrak GP JSON (2h cache)
//   /flights?bbox=lamin,lamax,lomin,lomax    — OpenSky states
//   /ip/:ip                                  — ip-api geo lookup
//   /domain/:domain                          — Host.io (needs HOSTIO_KEY)
//   /whois/:domain                           — WhoisXML (needs WHOISXML_KEY)
//   /name/:name                              — Genderize + Agify + Nationalize
//   /breach/:email                           — HIBP (needs HIBP_API_KEY)
//   /cve/:cveId                              — NVD CVE lookup
//   /crypto/btc/:address                     — Blockchair BTC dashboard
//   /crypto/eth/:address                     — Etherscan (needs ETHERSCAN_KEY)
//   /quotes                                  — ZenQuotes random
//   /countries                               — REST Countries all (24h cache)
//   /exchange/:base?target=                  — VATComply FX rates
//   /dns/:domain                             — Cloudflare DoH A records
//   /hackernews/:type                        — HN top/new/best IDs

import logger from '../../helpers/logger.js';

// ─── Cache ─────────────────────────────────────────────────────
// One Map keyed by cache key → { expiresAt, payload }. Every helper below
// calls `cachedFetch(key, ttlMs, loader)` which returns the payload straight
// from memory when fresh. Cache is process-local; that's fine — PM2 restarts
// blow it away and the upstream TTL is measured in minutes.
const CACHE = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000;   // 5 minutes for most endpoints
const EARTHQUAKE_TTL_MS = 60 * 1000;    // 1 minute
const SATELLITES_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const COUNTRIES_TTL_MS  = 24 * 60 * 60 * 1000;  // 24 hours

async function cachedFetch(key, ttlMs, loader) {
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && hit.expiresAt > now) return hit.payload;
  const payload = await loader();
  CACHE.set(key, { expiresAt: now + ttlMs, payload });
  return payload;
}

// ─── HTTP helpers ──────────────────────────────────────────────
// Wraps global fetch with a friendlier error shape. Throws `{ status, body }`
// on non-2xx so upstream HTTP codes propagate to the client.
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const contentType = res.headers.get('content-type') || '';
  let body;
  try {
    body = contentType.includes('application/json') || contentType.includes('dns-json')
      ? await res.json()
      : await res.text();
  } catch (e) {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(`upstream ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Sends `{ error, status }` on upstream failure. Server errors default to 502.
function sendUpstreamError(res, err, tag) {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
    ? err.status
    : 502;
  logger.error(`OSINT ${tag} FAIL | ${status}`, err?.message || err);
  return res.status(status).json({
    error: err?.message || 'upstream failure',
    status,
    detail: err?.body ?? null,
  });
}

// Log request timing consistently.
function logDone(tag, start, extra = '') {
  logger.info(`OSINT ${tag} | ${Date.now() - start}ms ${extra}`.trim());
}

const UA = 'siddharthfulia.com (eng@getpassionfruit.com)';

// ─── Handlers ──────────────────────────────────────────────────

// GET /osint/earthquakes?window=hour|day|week|month  (USGS, 60s cache)
export const getEarthquakes = async (req, res) => {
  const start = Date.now();
  try {
    const raw = String(req.query.window || 'day').toLowerCase();
    const allowed = ['hour', 'day', 'week', 'month'];
    const window = allowed.includes(raw) ? raw : 'day';
    const url = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_${window}.geojson`;
    const data = await cachedFetch(`eq:${window}`, EARTHQUAKE_TTL_MS, () => fetchJson(url));
    logDone('earthquakes', start, window);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'earthquakes');
  }
};

// GET /osint/eonet?days=20&limit=50&category=
export const getEonet = async (req, res) => {
  const start = Date.now();
  try {
    const days     = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 20));
    const limit    = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
    const category = (req.query.category || '').trim();
    const params = new URLSearchParams({ status: 'open', days: String(days), limit: String(limit) });
    if (category) params.set('category', category);
    const url = `https://eonet.gsfc.nasa.gov/api/v3/events?${params.toString()}`;
    const key = `eonet:${days}:${limit}:${category}`;
    const data = await cachedFetch(key, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('eonet', start, `days=${days} limit=${limit} cat=${category || '-'}`);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'eonet');
  }
};

// GET /osint/weather-alerts  (NOAA, requires descriptive UA)
export const getWeatherAlerts = async (req, res) => {
  const start = Date.now();
  try {
    const url = 'https://api.weather.gov/alerts/active?status=actual';
    const data = await cachedFetch('noaa:alerts', DEFAULT_TTL_MS, () =>
      fetchJson(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } })
    );
    logDone('weather-alerts', start);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'weather-alerts');
  }
};

// GET /osint/iss  (open-notify, HTTP)
export const getIss = async (req, res) => {
  const start = Date.now();
  try {
    const url = 'http://api.open-notify.org/iss-now.json';
    // Don't cache — this is a live position. But throttle to 5s.
    const data = await cachedFetch('iss', 5 * 1000, () => fetchJson(url));
    logDone('iss', start);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'iss');
  }
};

// GET /osint/astros  (open-notify, HTTP)
export const getAstros = async (req, res) => {
  const start = Date.now();
  try {
    const url = 'http://api.open-notify.org/astros.json';
    const data = await cachedFetch('astros', DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('astros', start);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'astros');
  }
};

// GET /osint/satellites?group=active  (CelesTrak, 2h cache)
export const getSatellites = async (req, res) => {
  const start = Date.now();
  try {
    const group = (req.query.group || 'active').replace(/[^a-z0-9\-_]/gi, '');
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
    const data = await cachedFetch(`sats:${group}`, SATELLITES_TTL_MS, () => fetchJson(url));
    logDone('satellites', start, group);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'satellites');
  }
};

// GET /osint/flights?bbox=lamin,lamax,lomin,lomax  (OpenSky, anon rate-limited)
export const getFlights = async (req, res) => {
  const start = Date.now();
  try {
    const bboxRaw = String(req.query.bbox || '').trim();
    let url = 'https://opensky-network.org/api/states/all';
    let cacheKey = 'flights:all';
    if (bboxRaw) {
      const parts = bboxRaw.split(',').map(s => parseFloat(s.trim()));
      if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
        return res.status(400).json({ error: 'bbox must be "lamin,lamax,lomin,lomax"', status: 400 });
      }
      const [lamin, lamax, lomin, lomax] = parts;
      const p = new URLSearchParams({
        lamin: String(lamin), lamax: String(lamax),
        lomin: String(lomin), lomax: String(lomax),
      });
      url = `https://opensky-network.org/api/states/all?${p.toString()}`;
      cacheKey = `flights:${lamin}:${lamax}:${lomin}:${lomax}`;
    }
    // OpenSky anonymous tier is quite tight — cache 60s.
    const data = await cachedFetch(cacheKey, 60 * 1000, () => fetchJson(url));
    logDone('flights', start, bboxRaw || 'all');
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'flights');
  }
};

// GET /osint/ip/:ip  (ip-api, free/no key)
export const getIp = async (req, res) => {
  const start = Date.now();
  try {
    const ip = String(req.params.ip || '').trim();
    if (!ip) return res.status(400).json({ error: 'ip is required', status: 400 });
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}`;
    const data = await cachedFetch(`ip:${ip}`, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('ip', start, ip);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'ip');
  }
};

// GET /osint/domain/:domain  (Host.io, needs HOSTIO_KEY)
export const getDomain = async (req, res) => {
  const start = Date.now();
  const key = process.env.HOSTIO_KEY;
  if (!key) return res.status(501).json({ error: 'auth-not-configured', status: 501 });
  try {
    const domain = String(req.params.domain || '').trim().toLowerCase();
    if (!domain) return res.status(400).json({ error: 'domain is required', status: 400 });
    const url = `https://host.io/api/domains/${encodeURIComponent(domain)}?token=${encodeURIComponent(key)}`;
    const data = await cachedFetch(`hostio:${domain}`, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('domain', start, domain);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'domain');
  }
};

// GET /osint/whois/:domain  (WhoisXML, needs WHOISXML_KEY)
export const getWhois = async (req, res) => {
  const start = Date.now();
  const key = process.env.WHOISXML_KEY;
  if (!key) return res.status(501).json({ error: 'auth-not-configured', status: 501 });
  try {
    const domain = String(req.params.domain || '').trim().toLowerCase();
    if (!domain) return res.status(400).json({ error: 'domain is required', status: 400 });
    const p = new URLSearchParams({
      domainName: domain,
      outputFormat: 'JSON',
      apiKey: key,
    });
    const url = `https://www.whoisxmlapi.com/whoisserver/WhoisService?${p.toString()}`;
    const data = await cachedFetch(`whois:${domain}`, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('whois', start, domain);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'whois');
  }
};

// GET /osint/name/:name  (Genderize + Agify + Nationalize, all free/no key)
// Fires all three in parallel and returns { name, gender, age, nationality }.
// Individual failures fall back to null so a single upstream hiccup doesn't
// nuke the whole response.
export const getName = async (req, res) => {
  const start = Date.now();
  try {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required', status: 400 });
    const cacheKey = `name:${name.toLowerCase()}`;
    const data = await cachedFetch(cacheKey, DEFAULT_TTL_MS, async () => {
      const q = `?name=${encodeURIComponent(name)}`;
      const [gender, age, nationality] = await Promise.all([
        fetchJson(`https://api.genderize.io${q}`).catch(() => null),
        fetchJson(`https://api.agify.io${q}`).catch(() => null),
        fetchJson(`https://api.nationalize.io${q}`).catch(() => null),
      ]);
      return { name, gender, age, nationality };
    });
    logDone('name', start, name);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'name');
  }
};

// GET /osint/breach/:email  (HaveIBeenPwned, needs HIBP_API_KEY)
export const getBreach = async (req, res) => {
  const start = Date.now();
  const key = process.env.HIBP_API_KEY;
  if (!key) return res.status(501).json({ error: 'auth-not-configured', status: 501 });
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required', status: 400 });
    const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`;
    const cacheKey = `breach:${email}`;
    const data = await cachedFetch(cacheKey, DEFAULT_TTL_MS, async () => {
      const r = await fetch(url, {
        headers: {
          'hibp-api-key': key,
          'user-agent': UA,
        },
      });
      // HIBP returns 404 for "no breaches" — surface that as an empty array
      // so consumers can treat this as a simple `.length` check.
      if (r.status === 404) return [];
      const contentType = r.headers.get('content-type') || '';
      const body = contentType.includes('application/json') ? await r.json() : await r.text();
      if (!r.ok) {
        const e = new Error(`upstream ${r.status}`);
        e.status = r.status;
        e.body = body;
        throw e;
      }
      return body;
    });
    logDone('breach', start, email);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'breach');
  }
};

// GET /osint/cve/:cveId  (NVD)
export const getCve = async (req, res) => {
  const start = Date.now();
  try {
    const cveId = String(req.params.cveId || '').trim().toUpperCase();
    if (!/^CVE-\d{4}-\d{4,}$/.test(cveId)) {
      return res.status(400).json({ error: 'cveId must match CVE-YYYY-NNNN', status: 400 });
    }
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`;
    const data = await cachedFetch(`cve:${cveId}`, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('cve', start, cveId);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'cve');
  }
};

// GET /osint/crypto/btc/:address  (Blockchair)
export const getCryptoBtc = async (req, res) => {
  const start = Date.now();
  try {
    const address = String(req.params.address || '').trim();
    if (!address) return res.status(400).json({ error: 'address is required', status: 400 });
    const url = `https://api.blockchair.com/bitcoin/dashboards/address/${encodeURIComponent(address)}`;
    const data = await cachedFetch(`btc:${address}`, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('crypto-btc', start, address);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'crypto-btc');
  }
};

// GET /osint/crypto/eth/:address  (Etherscan, needs ETHERSCAN_KEY)
export const getCryptoEth = async (req, res) => {
  const start = Date.now();
  const key = process.env.ETHERSCAN_KEY;
  if (!key) return res.status(501).json({ error: 'auth-not-configured', status: 501 });
  try {
    const address = String(req.params.address || '').trim();
    if (!address) return res.status(400).json({ error: 'address is required', status: 400 });
    const p = new URLSearchParams({
      module: 'account',
      action: 'balance',
      address,
      tag: 'latest',
      apikey: key,
    });
    const url = `https://api.etherscan.io/api?${p.toString()}`;
    const data = await cachedFetch(`eth:${address}`, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('crypto-eth', start, address);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'crypto-eth');
  }
};

// GET /osint/quotes  (ZenQuotes random)
export const getQuotes = async (req, res) => {
  const start = Date.now();
  try {
    const url = 'https://zenquotes.io/api/random';
    // Don't cache random quotes — that defeats the point. Fire fresh each call.
    const data = await fetchJson(url);
    logDone('quotes', start);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'quotes');
  }
};

// GET /osint/countries  (REST Countries all, 24h cache)
export const getCountries = async (req, res) => {
  const start = Date.now();
  try {
    const url = 'https://restcountries.com/v3.1/all?fields=name,cca2,cca3,capital,region,subregion,population,flags,latlng,currencies,languages,area,timezones';
    const data = await cachedFetch('countries:all', COUNTRIES_TTL_MS, () => fetchJson(url));
    logDone('countries', start);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'countries');
  }
};

// GET /osint/exchange/:base?target=  (VATComply FX)
export const getExchange = async (req, res) => {
  const start = Date.now();
  try {
    const base = String(req.params.base || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(base)) {
      return res.status(400).json({ error: 'base must be a 3-letter ISO currency code', status: 400 });
    }
    const target = String(req.query.target || '').trim().toUpperCase();
    const url = `https://api.vatcomply.com/rates?base=${encodeURIComponent(base)}`;
    const cacheKey = `fx:${base}`;
    const raw = await cachedFetch(cacheKey, DEFAULT_TTL_MS, () => fetchJson(url));
    // If target is supplied, respond with the shape { base, target, rate, date }
    // that most callers actually want. Otherwise pass upstream through unchanged.
    if (target && raw && raw.rates && Object.prototype.hasOwnProperty.call(raw.rates, target)) {
      logDone('exchange', start, `${base}->${target}`);
      return res.json({ base: raw.base, target, rate: raw.rates[target], date: raw.date });
    }
    logDone('exchange', start, base);
    return res.json(raw);
  } catch (err) {
    return sendUpstreamError(res, err, 'exchange');
  }
};

// GET /osint/dns/:domain  (Cloudflare DoH A records)
export const getDns = async (req, res) => {
  const start = Date.now();
  try {
    const domain = String(req.params.domain || '').trim().toLowerCase();
    if (!domain) return res.status(400).json({ error: 'domain is required', status: 400 });
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`;
    const data = await cachedFetch(`dns:A:${domain}`, DEFAULT_TTL_MS, () =>
      fetchJson(url, { headers: { Accept: 'application/dns-json' } })
    );
    logDone('dns', start, domain);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'dns');
  }
};

// GET /osint/hackernews/:type  (topstories | newstories | beststories)
export const getHackernews = async (req, res) => {
  const start = Date.now();
  try {
    const raw = String(req.params.type || '').toLowerCase();
    const allowed = ['topstories', 'newstories', 'beststories', 'askstories', 'showstories', 'jobstories'];
    const type = allowed.includes(raw) ? raw : 'topstories';
    const url = `https://hacker-news.firebaseio.com/v0/${type}.json`;
    const data = await cachedFetch(`hn:${type}`, DEFAULT_TTL_MS, () => fetchJson(url));
    logDone('hackernews', start, type);
    return res.json(data);
  } catch (err) {
    return sendUpstreamError(res, err, 'hackernews');
  }
};
