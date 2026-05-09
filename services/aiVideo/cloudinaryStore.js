// Cloudinary as the source of truth for completed videos.
// Uploads carry "context" key/value tags (prompt, provider, duration, etc.)
// which we read back on list. No DB needed — Cloudinary IS the DB.

import { v2 as cloudinary } from 'cloudinary';
import {
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_FOLDER,
} from '../../helpers/constants.js';

let _configured = false;
function configure() {
  if (_configured) return;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary not configured — set CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET in .env');
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  _configured = true;
}

export function isCloudinaryConfigured() {
  return !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

const FOLDER = CLOUDINARY_FOLDER || 'ai-videos';

// ─── Encoding metadata into Cloudinary "context" tags ──────
// Cloudinary context format: "key1=value1|key2=value2"
// Pipes/equals/quotes need escaping; non-ASCII (emojis) is rejected entirely.
function escapeContextValue(v) {
  if (v == null) return '';
  return String(v)
    .replace(/[^\x20-\x7E]/g, '')   // drop non-printable + non-ASCII (emojis)
    .replace(/\|/g, ' ')
    .replace(/=/g, ':')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 950);
}

function buildContext(meta = {}) {
  const pairs = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    pairs.push(`${k}=${escapeContextValue(v)}`);
  }
  return pairs.join('|');
}

function parseContext(custom = {}) {
  // Cloudinary returns context as { custom: { key1: val1, key2: val2 } }
  return custom || {};
}

// ─── Upload source image (used as I2V starting frame) ─────
// Accepts a base64 data URL from the FE, returns a public Cloudinary URL.
// Cloudinary auto-converts HEIC/WEBP/etc. to a delivered jpg/png; the worker
// downloads via the resulting secure_url, so any format ComfyUI's PIL backend
// can read works downstream.
export async function uploadSourceImage(dataUrl) {
  configure();
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Expected a data: URL');
  }
  const result = await cloudinary.uploader.upload(dataUrl, {
    resource_type: 'image',
    folder: `${FOLDER}/sources`,
    tags: ['ai-video-source'],
    // delivered as jpg for max ComfyUI compatibility (PIL handles all base formats)
    format: 'jpg',
  });
  return {
    url: result.secure_url,
    publicId: result.public_id,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    format: result.format,
  };
}


// ─── Upload ─────────────────────────────────────────────────
export async function uploadVideoBuffer(buffer, videoId, meta = {}, opts = {}) {
  configure();
  const context = buildContext({
    prompt: meta.prompt,
    provider: meta.provider,
    duration: meta.duration,
    aspectRatio: meta.aspectRatio,
    resolution: meta.resolution,
    style: meta.style,
    audio: meta.audio == null ? '' : (meta.audio ? '1' : '0'),
    caption: meta.caption,
    model: meta.model,
    createdAt: meta.createdAt || new Date().toISOString(),
  });

  // Server-side trim. ZSky pads its output by ~2s to fit a watermark; cropping
  // to the user's *requested* duration drops it cleanly without touching ffmpeg.
  // Pass `trimToSeconds` to enforce this on upload.
  const uploadOptions = {
    resource_type: 'video',
    public_id: videoId,
    folder: FOLDER,
    context,
    tags: [meta.provider || 'unknown', meta.aspectRatio || ''].filter(Boolean),
    chunk_size: 6_000_000,
  };
  if (opts.trimToSeconds && opts.trimToSeconds > 0) {
    uploadOptions.transformation = [{ end_offset: String(opts.trimToSeconds) }];
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
    stream.end(buffer);
  });
}

/**
 * Upload a raw audio buffer (mp3 / wav / ogg). Used by /api/music/generate
 * to persist HF Inference output. Returns { url, publicId, bytes }.
 */
export async function uploadAudioBuffer(buffer, mimeType = 'audio/mpeg') {
  configure();
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : 'mp3';
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        // Cloudinary stores audio under the 'video' resource_type bucket.
        resource_type: 'video',
        folder: `${FOLDER}/audio`,
        public_id: `music_${Date.now()}`,
        format: ext,
        context: { kind: 'music', createdAt: new Date().toISOString() },
        tags: ['music', 'standalone'],
      },
      (err, res) => {
        if (err) return reject(err);
        resolve({ url: res.secure_url, publicId: res.public_id, bytes: res.bytes });
      },
    );
    stream.end(buffer);
  });
}

// Build a Cloudinary thumbnail URL from a stored video URL — used by the FE
// to render Library cards without preloading actual MP4s.
export function thumbnailFromVideoUrl(videoUrl, opts = {}) {
  if (!videoUrl || !/cloudinary\.com\/.+\/video\/upload\//.test(videoUrl)) return null;
  const w = opts.width || 400;
  const so = opts.startOffset != null ? opts.startOffset : 1;
  const transform = `so_${so},w_${w},c_fill,q_auto,f_jpg`;
  return videoUrl
    .replace('/video/upload/', `/video/upload/${transform}/`)
    .replace(/\.(mp4|webm|mov)$/i, '.jpg');
}

// ─── List with pagination ──────────────────────────────────
// Cloudinary admin API uses `next_cursor` for pagination, not page numbers.
// We fetch all pages up to a soft cap, then slice locally for page numbers.
export async function listVideos({ provider, page = 1, limit = 12 } = {}) {
  configure();
  const expression = [
    'resource_type:video',
    `folder:${FOLDER}`,
    provider ? `tags:${provider}` : '',
  ].filter(Boolean).join(' AND ');

  const r = await cloudinary.search
    .expression(expression)
    .sort_by('created_at', 'desc')
    .max_results(500)
    .with_field('context')
    .with_field('tags')
    .execute();

  const all = (r.resources || []).map(toRecord);
  const start = Math.max(0, (page - 1) * limit);
  const slice = all.slice(start, start + limit);

  return {
    items: slice,
    total: all.length,
    page,
    limit,
    pages: Math.max(1, Math.ceil(all.length / limit)),
    hasMore: start + slice.length < all.length,
  };
}

function toRecord(r) {
  const ctx = parseContext(r.context?.custom);
  return {
    videoId: r.public_id?.split('/').pop() || r.asset_id,
    publicId: r.public_id,
    videoUrl: r.secure_url,
    provider: ctx.provider || (r.tags?.[0] ?? 'unknown'),
    prompt: ctx.prompt || '',
    caption: ctx.caption || null,
    duration: Number(ctx.duration) || null,
    aspectRatio: ctx.aspectRatio || null,
    resolution: ctx.resolution || null,
    style: ctx.style || null,
    audio: ctx.audio === '1' ? true : ctx.audio === '0' ? false : null,
    model: ctx.model || null,
    createdAt: ctx.createdAt || r.created_at,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    durationSec: r.duration,
    status: 'completed',
  };
}

// ─── Get one ────────────────────────────────────────────────
export async function getVideo(videoId) {
  configure();
  const publicId = `${FOLDER}/${videoId}`;
  try {
    const r = await cloudinary.api.resource(publicId, {
      resource_type: 'video',
      context: true,
      tags: true,
    });
    return toRecord(r);
  } catch (e) {
    if (e?.error?.http_code === 404 || /not found/i.test(e?.message || '')) return null;
    throw e;
  }
}

// ─── Get latest ─────────────────────────────────────────────
export async function getLatestVideo() {
  const { items } = await listVideos({ page: 1, limit: 1 });
  return items[0] || null;
}

// ─── Delete ─────────────────────────────────────────────────
export async function deleteVideo(videoId) {
  configure();
  const publicId = `${FOLDER}/${videoId}`;
  const r = await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
  return { ok: r?.result === 'ok' || r?.result === 'not found', result: r?.result };
}
