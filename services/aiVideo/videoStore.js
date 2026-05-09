// SQLite-backed cache of completed video metadata. The Cloudinary file is
// still the canonical asset (mp4 lives there), but every successful upload
// writes its URL + metadata here too so the Library can:
//   • paginate / filter without paying the Cloudinary Search API
//   • survive Cloudinary outages (URLs cached locally)
//   • be queried by SQL (provider, date range, model, etc.)
//
// Cloudinary remains the fallback in cloudinaryStore.js — if a video predates
// SQLite or the local row is missing, listVideos() merges the two sources.

import { db } from './db.js';

const insertStmt = db.prepare(`INSERT OR REPLACE INTO videos (
  videoId, publicId, videoUrl, prompt, provider, model, duration, aspectRatio,
  resolution, style, audio, caption, bytes, createdAt, cloudinaryContext
) VALUES (
  @videoId, @publicId, @videoUrl, @prompt, @provider, @model, @duration, @aspectRatio,
  @resolution, @style, @audio, @caption, @bytes, @createdAt, @cloudinaryContext
)`);

const listStmt = db.prepare(
  'SELECT * FROM videos ORDER BY createdAt DESC LIMIT @limit OFFSET @offset'
);
const listByProviderStmt = db.prepare(
  'SELECT * FROM videos WHERE provider = @provider ORDER BY createdAt DESC LIMIT @limit OFFSET @offset'
);
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM videos');
const countByProviderStmt = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE provider = ?');
const getStmt = db.prepare('SELECT * FROM videos WHERE videoId = ?');
const deleteStmt = db.prepare('DELETE FROM videos WHERE videoId = ?');

export function recordVideo(meta) {
  insertStmt.run({
    videoId: meta.videoId,
    publicId: meta.publicId || meta.videoId,
    videoUrl: meta.videoUrl,
    prompt: meta.prompt ?? null,
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    duration: meta.duration ?? null,
    aspectRatio: meta.aspectRatio ?? null,
    resolution: meta.resolution ?? null,
    style: meta.style ?? null,
    audio: meta.audio == null ? null : (meta.audio ? 1 : 0),
    caption: meta.caption ?? null,
    bytes: meta.bytes ?? null,
    createdAt: meta.createdAt || new Date().toISOString(),
    cloudinaryContext: meta.cloudinaryContext ? JSON.stringify(meta.cloudinaryContext) : null,
  });
}

function rowToVideo(r) {
  if (!r) return null;
  return {
    videoId: r.videoId,
    publicId: r.publicId,
    videoUrl: r.videoUrl,
    prompt: r.prompt,
    provider: r.provider,
    model: r.model,
    duration: r.duration,
    aspectRatio: r.aspectRatio,
    resolution: r.resolution,
    style: r.style,
    audio: r.audio == null ? null : !!r.audio,
    caption: r.caption,
    bytes: r.bytes,
    createdAt: r.createdAt,
    status: 'completed',
  };
}

export function listLocalVideos({ provider, page = 1, limit = 12 }) {
  const offset = (Math.max(page, 1) - 1) * limit;
  if (provider) {
    return {
      items: listByProviderStmt.all({ provider, limit, offset }).map(rowToVideo),
      total: countByProviderStmt.get(provider).n,
    };
  }
  return {
    items: listStmt.all({ limit, offset }).map(rowToVideo),
    total: countStmt.get().n,
  };
}

export function getLocalVideo(videoId) {
  return rowToVideo(getStmt.get(videoId));
}

export function deleteLocalVideo(videoId) {
  return deleteStmt.run(videoId).changes > 0;
}
