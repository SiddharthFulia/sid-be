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
import crypto from 'crypto';
import multer from 'multer';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import logger from '../../helpers/logger.js';
import { success, error } from '../../helpers/res_helper.js';

const HF_TOKEN = (process.env.HF_TOKEN || process.env.HF_API_KEY || '').trim();

// Curated slug → sample-scene metadata. These files are pre-staged
// on disk under data/splat-cache/<slug>.ksplat (extracted from
// mkkellogg's official Gaussian-Splats-3D demo bundle at
// projects.markkellogg.org/downloads/gaussian_splat_data.zip).
//
// `url` is left as a fallback — if the cached file goes missing
// (e.g. fresh clone of the repo), the controller can re-fetch from
// that URL. Today all three are extracted from the same 564 MB zip
// so no individual `url` is set; the file just has to exist.
//
// To add a new sample:
//   1. Drop the file at data/splat-cache/<slug>.<ext>
//   2. Add an entry below with the matching slug + ext + label
//   3. Add a chip to SAMPLE_SCENES in portfolio/src/pages/SplatViewer.jsx
const SAMPLES = {
  bonsai: {
    ext: '.ksplat',
    label: 'Bonsai (small)',
  },
  truck: {
    ext: '.ksplat',
    label: 'Truck (medium)',
  },
  garden: {
    ext: '.ksplat',
    label: 'Garden (large)',
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
  if (!spec.url) {
    throw new Error(
      `Sample ${slug} expects pre-staged file at ${dest} but it doesn't exist. ` +
      `Either drop the file there manually or set spec.url so I can fetch it.`
    );
  }

  const headers = {};
  if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;

  logger.info(`[splat-sample] downloading ${slug} from ${spec.url} …`);
  const res = await fetch(spec.url, { headers });
  if (!res.ok) {
    throw new Error(`Upstream returned ${res.status} ${res.statusText} for ${spec.url}`);
  }
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

// ─── User uploads — Splat Viewer ─────────────────────────────────
// Lets the FE post a user's splat file once, then loads it from
// /api/splat-upload/:id.<ext>. Two reasons we route this through
// the BE instead of blob URLs:
//   1. Big captures (200-500 MB) sit in browser memory the whole
//      session if held as a blob. A BE URL lets the library
//      stream + GC the bytes between scene loads.
//   2. The Range-supported BE response means the library can
//      progress-bar the decode the same way it does for chips.
// Files land in data/splat-uploads/. They are NOT permanent —
// see TTL note inside the cleanup helper.

const UPLOAD_DIR = path.join(ROOT, 'data', 'splat-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const VALID_EXTS = new Set(['.ply', '.splat', '.ksplat', '.spz']);

const splatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const id  = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname || '').toLowerCase() || '.ksplat';
    if (!VALID_EXTS.has(ext)) return cb(new Error(`Unsupported extension: ${ext}`));
    cb(null, `${id}${ext}`);
  },
});
const splatUpload = multer({
  storage: splatStorage,
  limits: { fileSize: 600 * 1024 * 1024 },   // 600 MB hard cap — bigger splats are rare on consumer hw
});
export const splatUploadMiddleware = splatUpload.single('splat');

// One-shot TTL sweep: anything older than 24 h gets removed on the
// next upload. Stops the dir from growing forever without any cron.
function sweepStaleUploads() {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, name);
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs > TTL) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
  } catch (_) {}
}

export const postSplatUpload = (req, res) => {
  if (!req.file) return error(res, 'Upload a video field named "splat"', 400);
  sweepStaleUploads();
  const name = req.file.filename;     // e.g. <id>.ksplat
  const id   = path.parse(name).name;
  const url  = `/api/splat-upload/${name}`;
  logger.info(`[splat-upload] received ${name} · ${(req.file.size / (1024 * 1024)).toFixed(1)} MB`);
  return success(res, {
    id,
    url,
    filename: name,
    bytes: req.file.size,
  });
};

export const getSplatUpload = (req, res) => {
  // Filename is `<id>.<ext>` — id is the random hex we minted, ext
  // is whatever the user uploaded. Reject anything with directory
  // separators so a crafted path can't escape the upload dir.
  const raw  = String(req.params.name || '');
  if (!/^[a-f0-9]{16}\.[a-z]+$/i.test(raw)) return error(res, 'Bad upload id', 400);
  const ext  = path.extname(raw).toLowerCase();
  if (!VALID_EXTS.has(ext)) return error(res, 'Unsupported extension', 400);
  const filePath = path.join(UPLOAD_DIR, raw);
  if (!fs.existsSync(filePath)) return error(res, 'Upload not found (may have expired)', 404);

  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type',  contentTypeFor(ext));
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="${raw}"`);

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
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  fs.createReadStream(filePath).pipe(res);
};
