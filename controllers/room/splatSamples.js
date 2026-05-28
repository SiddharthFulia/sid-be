// /api/splat-sample/:slug — serve a curated list of demo Gaussian
// splat scenes for the /splat viewer. The upstream files live on
// Hugging Face behind auth, so the browser can't fetch them
// directly (401). This controller:
//
//   1. On first request: stream the HF file down using HF_TOKEN
//      from the BE .env, cache to disk at data/splat-cache/<slug>.
//   2. On subsequent requests: stream the cached file with proper
//      Content-Type + Content-Length so the splat library can
//      progress-bar it.
//
// Why cache instead of proxy-on-every-hit: 28 MB ksplat × N users
// would eat Oracle's bandwidth in days. The cache is a one-shot
// per slug, lives forever (re-downloadable any time by deleting
// the file).

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import logger from '../../helpers/logger.js';
import { error } from '../../helpers/res_helper.js';

const HF_TOKEN = (process.env.HF_TOKEN || process.env.HF_API_KEY || '').trim();

// Curated slug → HF URL map. Add new entries here; the slug is what
// the FE sample chip uses, so keep them stable.
const SAMPLES = {
  garden: {
    url: 'https://huggingface.co/cakewalk/sample-splat/resolve/main/garden_high.ksplat',
    ext: '.ksplat',
    label: 'Garden (INRIA)',
  },
  truck: {
    url: 'https://huggingface.co/cakewalk/sample-splat/resolve/main/truck_high.ksplat',
    ext: '.ksplat',
    label: 'Truck (TanksAndTemples)',
  },
};

const ROOT       = process.cwd();
const CACHE_DIR  = path.join(ROOT, 'data', 'splat-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function cachePathFor(slug) {
  const spec = SAMPLES[slug];
  if (!spec) return null;
  return path.join(CACHE_DIR, `${slug}${spec.ext}`);
}

function contentTypeFor(ext) {
  if (ext === '.ksplat') return 'application/octet-stream';
  if (ext === '.splat')  return 'application/octet-stream';
  if (ext === '.spz')    return 'application/octet-stream';
  if (ext === '.ply')    return 'application/octet-stream';
  return 'application/octet-stream';
}

async function downloadToCache(slug) {
  const spec = SAMPLES[slug];
  const dest = cachePathFor(slug);
  if (!spec || !dest) throw new Error(`Unknown sample slug: ${slug}`);

  const headers = {};
  if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;

  logger.info(`[splat-sample] downloading ${slug} from HF …`);
  const res = await fetch(spec.url, { headers });
  if (!res.ok) {
    throw new Error(`HF returned ${res.status} ${res.statusText} for ${spec.url}`);
  }
  // Write to a temp file first so a partial download never wins the
  // cache race.
  const tmp = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  const { size } = fs.statSync(dest);
  logger.info(`[splat-sample] cached ${slug} · ${(size / (1024 * 1024)).toFixed(1)} MB`);
  return dest;
}

// In-flight download promises so two simultaneous first-clicks
// don't both download the same file.
const inflight = new Map();

export const getSplatSample = async (req, res) => {
  // FE includes the extension on the URL (`/garden.ksplat`) so the
  // splat library's URL-based format autodetect picks the right
  // loader. Strip everything from the first `.` so the slug match
  // works regardless.
  const raw  = String(req.params.slug || '').toLowerCase();
  const slug = raw.replace(/\.[a-z0-9]+$/, '');
  const spec = SAMPLES[slug];
  if (!spec) return error(res, 'Unknown sample', 404);

  let cached = cachePathFor(slug);
  if (!fs.existsSync(cached)) {
    try {
      if (!inflight.has(slug)) inflight.set(slug, downloadToCache(slug));
      await inflight.get(slug);
    } catch (err) {
      logger.error(`[splat-sample] download failed for ${slug}: ${err.message}`);
      return error(res, `Could not fetch sample: ${err.message}`, 502);
    } finally {
      inflight.delete(slug);
    }
  }

  if (!fs.existsSync(cached)) {
    return error(res, 'Cache write failed', 500);
  }

  const stat = fs.statSync(cached);

  res.setHeader('Content-Type', contentTypeFor(spec.ext));
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${slug}${spec.ext}"`);

  // Honour Range requests so the splat library can progress-bar +
  // resume partial reads on slow connections.
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end   = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      res.status(206);
      res.setHeader('Content-Range',  `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Accept-Ranges',  'bytes');
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(cached, { start, end }).pipe(res);
    }
  }

  fs.createReadStream(cached).pipe(res);
};

export const listSplatSamples = (_req, res) => {
  const items = Object.entries(SAMPLES).map(([slug, spec]) => ({
    slug,
    label: spec.label,
    ext:   spec.ext,
    cached: fs.existsSync(cachePathFor(slug)),
  }));
  res.json({ status: true, data: { items } });
};
