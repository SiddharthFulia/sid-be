import http from 'http';
import { NASA_API_KEY, WEATHER_API_KEY } from '../helpers/constants.js';

/** Fetch that works with http:// URLs (Node's native fetch can be flaky with plain HTTP) */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const cleaned = data.trim().replace(/^\uFEFF/, ''); // strip BOM + whitespace
          resolve(JSON.parse(cleaned));
        } catch {
          reject(new Error(`Invalid JSON from ${url} (${data.length} bytes)`));
        }
      });
    }).on('error', reject)
      .setTimeout(8000, function() { this.destroy(); reject(new Error('Timeout: ' + url)); });
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
  'proxy/pokemon': (query) => {
    const params = new URLSearchParams();
    params.set('limit', query.limit || '151');
    if (query.offset) params.set('offset', query.offset);
    return `https://pokeapi.co/api/v2/pokemon?${params}`;
  },
  'proxy/pokemon-detail': (query) => {
    return `https://pokeapi.co/api/v2/pokemon/${query.id}`;
  },
  'proxy/artworks': (query) => {
    const params = new URLSearchParams();
    params.set('page', query.page || '1');
    params.set('limit', query.limit || '20');
    params.set('fields', 'id,title,artist_display,date_display,image_id,thumbnail,dimensions,medium_display');
    if (query.q) params.set('q', query.q);
    return `https://api.artic.edu/api/v1/artworks?${params}`;
  },
  'proxy/weather': (query) => {
    return `https://api.openweathermap.org/data/2.5/weather?q=${query.city}&units=metric&appid=${WEATHER_API_KEY}`;
  },
  'proxy/forecast': (query) => {
    return `https://api.openweathermap.org/data/2.5/forecast?q=${query.city}&units=metric&appid=${WEATHER_API_KEY}`;
  },
  'proxy/sunrise': (query) => {
    return `https://api.sunrise-sunset.org/json?lat=${query.lat}&lng=${query.lng}&formatted=0`;
  },
  'proxy/rickmorty': (query) => {
    return `https://rickandmortyapi.com/api/character?page=${query.page || 1}${query.name ? '&name=' + query.name : ''}`;
  },
  'proxy/rickmorty-detail': (query) => {
    return `https://rickandmortyapi.com/api/character/${query.id}`;
  },
  'proxy/randomdog': (query) => {
    return `https://dog.ceo/api/breeds/image/random/${query.count || 6}`;
  },
  'proxy/dogbreeds': () => {
    return `https://dog.ceo/api/breeds/list/all`;
  },
  'proxy/dogbreed': (query) => {
    return `https://dog.ceo/api/breed/${query.breed}/images/random/${query.count || 6}`;
  },
  'proxy/quotes': () => {
    return 'https://zenquotes.io/api/quotes';
  },
  'proxy/countries': () => {
    return `https://restcountries.com/v3.1/all?fields=name,flags,capital,population,region,languages,currencies,area`;
  },
  'proxy/country': (query) => {
    return `https://restcountries.com/v3.1/name/${query.name}?fields=name,flags,capital,population,region,subregion,languages,currencies,area,borders,timezones,latlng`;
  },
  'proxy/memes': () => 'https://api.imgflip.com/get_memes',
  'proxy/launches': (query) => {
    const params = new URLSearchParams();
    params.set('limit', query.limit || '10');
    params.set('ordering', '-net');
    return `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?${params}`;
  },
  'proxy/foodish': (query) => {
    if (query.category) return `https://foodish-api.com/api/images/${query.category}`;
    return 'https://foodish-api.com/api/';
  },
  'proxy/mtg': (query) => {
    if (query.random === 'true') return 'https://api.scryfall.com/cards/random';
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    params.set('page', query.page || '1');
    return `https://api.scryfall.com/cards/search?${params}`;
  },
};

export async function proxyNasa(endpoint, query = {}) {
  // Check if it's a third-party proxy route
  const proxyFn = PROXY_ROUTES[endpoint];
  if (proxyFn) {
    const url = proxyFn(query);
    const cacheKey = `proxy:${url}`;

    // Skip cache for random/fresh endpoints
    const noCacheEndpoints = ['proxy/iss', 'proxy/randomdog', 'proxy/dogbreed', 'proxy/quotes', 'proxy/foodish', 'proxy/mtg'];
    const shouldCache = !noCacheEndpoints.includes(endpoint);

    if (shouldCache) {
      const cached = getCached(cacheKey);
      if (cached) return cached;
    }

    // Use http module for plain HTTP URLs, fetch for HTTPS
    let data;
    if (url.startsWith('http://')) {
      // Retry once on failure (open-notify can be flaky)
      try { data = await httpGet(url); }
      catch { data = await httpGet(url); }
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Upstream ${res.status}: ${res.statusText}`);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) throw new Error('Upstream returned HTML — API may be down');
      data = await res.json();
    }
    if (shouldCache) setCache(cacheKey, data);
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
