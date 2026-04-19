import http from 'http';
import { NASA_API_KEY } from '../helpers/constants.js';

/** Fetch that works with http:// URLs (Node's native fetch can be flaky with plain HTTP) */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

// In-memory cache (10 min TTL)
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Evict old entries if cache gets too large
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// Third-party API mappings (CORS-blocked from frontend)
const PROXY_ROUTES = {
  'proxy/fireball': (query) => {
    let url = 'https://ssd-api.jpl.nasa.gov/fireball.api?req-loc=true';
    if (query['date-min']) url += `&date-min=${query['date-min']}`;
    if (query['date-max']) url += `&date-max=${query['date-max']}`;
    return url;
  },
  'proxy/iss': () => 'http://api.open-notify.org/iss-now.json',
  'proxy/astros': () => 'http://api.open-notify.org/astros.json',
  'proxy/tle': (query) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    params.set('page_size', query.page_size || '20');
    return `https://tle.ivanstanojevic.me/api/tle/?${params}`;
  },
  'proxy/eonet': (query) => {
    const params = new URLSearchParams();
    params.set('limit', query.limit || '50');
    if (query.status) params.set('status', query.status);
    return `https://eonet.gsfc.nasa.gov/api/v3/events?${params}`;
  },
  'proxy/images': (query) => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.media_type) params.set('media_type', query.media_type);
    if (query.page) params.set('page', query.page);
    if (query.page_size) params.set('page_size', query.page_size);
    return `https://images-api.nasa.gov/search?${params}`;
  },
  'proxy/techtransfer': (query) => {
    const term = query.q || 'engine';
    return `https://api.nasa.gov/techtransfer/patent/?${encodeURIComponent(term)}&api_key=${NASA_API_KEY}`;
  },
};

export async function proxyNasa(endpoint, query = {}) {
  // Check if it's a third-party proxy route
  const proxyFn = PROXY_ROUTES[endpoint];
  if (proxyFn) {
    const url = proxyFn(query);
    const cacheKey = `proxy:${url}`;

    // ISS position should not be cached
    if (endpoint !== 'proxy/iss') {
      const cached = getCached(cacheKey);
      if (cached) return cached;
    }

    // Use http module for plain HTTP URLs, fetch for HTTPS
    let data;
    if (url.startsWith('http://')) {
      data = await httpGet(url);
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Upstream ${res.status}: ${res.statusText}`);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) throw new Error('Upstream returned HTML — API may be down');
      data = await res.json();
    }
    if (endpoint !== 'proxy/iss') setCache(cacheKey, data);
    return data;
  }

  // NASA API proxy — append API key
  const params = new URLSearchParams(query);
  params.set('api_key', NASA_API_KEY);
  const url = `https://api.nasa.gov/${endpoint}?${params}`;
  const cacheKey = `nasa:${url}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 429) throw new Error('Rate limit reached');
    throw new Error(`NASA API ${res.status}: ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error('NASA API returned HTML — endpoint may be down');
  }

  const data = await res.json();
  setCache(cacheKey, data);
  return data;
}
