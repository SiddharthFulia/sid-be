import { ZSKY_API_KEY, ZSKY_API_URL } from '../../helpers/constants.js';
import { getAccessToken, isConfigured as zskyAuthConfigured, forceRefresh } from './zskyAuth.js';

const BASE = (() => {
  try {
    const u = new URL(ZSKY_API_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://zsky.ai';
  }
})();
const GENERATE_URL = `${BASE}/api/generate`;
const JOB_URL = (id) => `${BASE}/api/job/${id}`;

export const ZSKY_MODELS = {
  cinematic: 'cinematic',
  realistic: 'realistic',
  anime: 'anime',
  cartoon: 'cartoon',
};

const AR_DIMS = {
  '16:9': { w: 1280, h: 720 },
  '9:16': { w: 720, h: 1280 },
  '1:1':  { w: 848, h: 848 },
};

const LENGTH_MAP = { 5: 121, 7: 169, 10: 241 };

const QUALITY_SUFFIX = { sd: '_sd', hd: '', '720p': '', '1080p': '_1080p', '2k': '_2k', '4k': '_4k' };

const POLL_INTERVAL = 2500;
const POLL_TIMEOUT = 6 * 60 * 1000;

function buildType(audio, resolution, isImg2Vid) {
  const baseMode = isImg2Vid ? 'i2v' : 'video';
  const suffix = QUALITY_SUFFIX[(resolution || '720p').toLowerCase()] ?? '';
  if (suffix) return `${baseMode}${suffix}`;
  return audio ? `${baseMode}_av` : baseMode;
}

async function buildHeaders({ forceTokenRefresh = false } = {}) {
  // Browser-like headers so Cloudflare bot mitigation doesn't reject the request.
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': BASE,
    'Referer': `${BASE}/create`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Sec-CH-UA': '"Chromium";v="130", "Not?A_Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  // Auth precedence: refresh-token flow (free account) > static API key > anonymous
  if (zskyAuthConfigured()) {
    try {
      const token = forceTokenRefresh ? await forceRefresh() : await getAccessToken();
      h['Authorization'] = `Bearer ${token}`;
    } catch {
      // fall through; ZSky will return its own auth error
    }
  } else if (ZSKY_API_KEY) {
    h['Authorization'] = `Bearer ${ZSKY_API_KEY}`;
  }
  return h;
}

async function urlToBase64(imageUrl) {
  const r = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Failed to fetch image_url: ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) throw new Error(`image_url did not return an image (got ${ct})`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab).toString('base64');
}

async function downloadResult(result) {
  if (result?.base64) return Buffer.from(result.base64, 'base64');
  if (result?.url) {
    const fullUrl = result.url.startsWith('http') ? result.url : `${BASE}/api${result.url}`;
    const r = await fetch(fullUrl);
    if (!r.ok) throw new Error(`Failed to download ZSky video: ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  }
  throw new Error('ZSky result missing both url and base64');
}

const TRANSIENT_PATTERNS = [
  /produced no output/i,
  /rejected the workflow/i,
  /worker.*crashed/i,
  /internal.*error/i,
  /try again/i,
];

function isTransientError(msg) {
  return TRANSIENT_PATTERNS.some(p => p.test(msg || ''));
}

async function pollJob(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    const r = await fetch(JOB_URL(jobId), { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      if (j.status === 'completed' || j.status === 'complete') {
        const results = j.results || j.result || [];
        if (!results.length) {
          const e = new Error('ZSky job completed with empty results');
          e.transient = true;
          throw e;
        }
        return results[0];
      }
      if (j.status === 'failed') {
        const e = new Error(j.error || 'ZSky generation failed');
        if (isTransientError(j.error)) e.transient = true;
        throw e;
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error('ZSky generation timed out');
}

export async function generateZskyVideo(prompt, opts = {}) {
  try {
    return await runZsky(prompt, opts);
  } catch (err) {
    if (err.transient && !opts._isRetry) {
      await new Promise(r => setTimeout(r, 6000));
      return runZsky(prompt, { ...opts, _isRetry: true });
    }
    throw err;
  }
}

async function runZsky(prompt, opts = {}) {
  const aspect = opts.aspectRatio || '9:16';
  const dims = AR_DIMS[aspect] || AR_DIMS['9:16'];
  const length = LENGTH_MAP[opts.duration] || 121;
  const audio = opts.audio !== false;
  const isImg2Vid = !!opts.imageUrl;
  const type = buildType(audio, opts.resolution, isImg2Vid);

  const body = {
    prompt,
    type,
    width: dims.w,
    height: dims.h,
    length,
    age_verified: true,
    tier: 'free',
  };

  if (isImg2Vid) {
    body.image_base64 = await urlToBase64(opts.imageUrl);
  }

  let res = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  // If unauthorized AND we have a refresh token, force-refresh and retry once.
  if ((res.status === 401 || res.status === 403) && zskyAuthConfigured()) {
    try {
      res = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: await buildHeaders({ forceTokenRefresh: true }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
    } catch {}
  }

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err.error || err.message || JSON.stringify(err);
    } catch {}
    if (res.status === 401 || res.status === 403) {
      const hint = zskyAuthConfigured()
        ? 'ZSky token refresh failed — your refresh_token may have expired. Log in at zsky.ai again, copy the new refresh_token from DevTools (Application → Local Storage → sb-yrkfputkviojshtnguwt-auth-token), paste into ZSKY_REFRESH_TOKEN in sid-be/.env, restart BE.'
        : 'ZSky requires sign-in. Get a free account at zsky.ai, copy refresh_token from DevTools (Application → Local Storage), paste into ZSKY_REFRESH_TOKEN in sid-be/.env, restart BE.';
      throw new Error(hint);
    }
    if (res.status === 402) {
      const e = new Error(`ZSky credit limit hit — ${detail}`);
      e.contentPolicy = false;
      throw e;
    }
    if (res.status === 429) {
      const m = detail.match(/(\d+)\s*seconds?/i);
      const wait = m ? m[1] : '60';
      throw new Error(`ZSky rate limit hit (10 req/min on free tier). Wait ~${wait}s and try again.`);
    }
    if (res.status === 451 || res.status === 422 || /safety|moderat|polic|flag|inappropriate|prompt can.?t/i.test(detail)) {
      const err = new Error(`Your prompt was flagged by ZSky's safety filter. Try rephrasing — avoid celebrity names, real people, violence, NSFW, brand names, and copyrighted characters.`);
      err.contentPolicy = true;
      throw err;
    }
    throw new Error(`ZSky ${res.status}: ${detail || 'request rejected'}`);
  }

  const data = await res.json();
  if (!data.job_id) throw new Error(data.error || 'ZSky did not return a job_id');

  const result = await pollJob(data.job_id);
  const buffer = await downloadResult(result);

  if (!buffer || buffer.length === 0) throw new Error('ZSky returned an empty video buffer');

  return {
    buffer,
    provider: 'zsky',
    model: opts.style || opts.model || 'cinematic',
    contentType: result.content_type || 'video/mp4',
  };
}

export const generateVideoZSky = generateZskyVideo;
