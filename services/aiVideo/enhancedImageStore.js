// SQLite store for the Image Enhancer pipeline.
// Single table (`enhanced_images`) holds every state — queued / processing /
// completed / failed. Library / Queue / Failures views are filtered queries.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newImageId() {
  return `img_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO enhanced_images (
  imageId, status, type, engine, presetId, prompt, sourceUrl, outputUrl,
  error, bytes, workerId, createdAt, startedAt, completedAt
) VALUES (
  @imageId, @status, @type, @engine, @presetId, @prompt, @sourceUrl, @outputUrl,
  @error, @bytes, @workerId, @createdAt, @startedAt, @completedAt
)`);

const selectStmt = db.prepare('SELECT * FROM enhanced_images WHERE imageId = ?');
const deleteStmt = db.prepare('DELETE FROM enhanced_images WHERE imageId = ?');
const nextQueuedStmt = db.prepare(
  "SELECT * FROM enhanced_images WHERE engine = 'local' AND status = 'queued' ORDER BY createdAt ASC LIMIT 1"
);
const countsStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status='queued'     THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing,
    SUM(CASE WHEN status='completed'  THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='failed'     THEN 1 ELSE 0 END) AS failed
  FROM enhanced_images
`);

const COLUMNS = new Set([
  'status', 'type', 'engine', 'presetId', 'prompt', 'sourceUrl', 'outputUrl',
  'error', 'bytes', 'workerId', 'startedAt', 'completedAt',
]);

export function createImage(data) {
  const row = {
    imageId: newImageId(),
    status: 'queued',
    type: 'fast',
    engine: 'cloud',
    presetId: null,
    prompt: '',
    sourceUrl: null,
    outputUrl: null,
    error: null,
    bytes: null,
    workerId: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...data,
  };
  insertStmt.run(row);
  return row;
}

export function getImage(imageId) {
  return selectStmt.get(imageId) || null;
}

export function updateImage(imageId, patch) {
  const existing = selectStmt.get(imageId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => COLUMNS.has(c));
  if (cols.length === 0) return existing;
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE enhanced_images SET ${set} WHERE imageId = @imageId`)
    .run({ imageId, ...Object.fromEntries(cols.map(c => [c, patch[c]])) });
  return selectStmt.get(imageId);
}

export function deleteImage(imageId) {
  return deleteStmt.run(imageId).changes > 0;
}

export function getNextQueuedImageJob() {
  return nextQueuedStmt.get() || null;
}

// Paginated list for the Library/Jobs tabs. Filter by status / type / engine.
export function listImages({ status, type, engine, page = 1, limit = 24 } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  const where = [];
  const params = { limit, offset };
  if (status) { where.push('status = @status'); params.status = status; }
  if (type)   { where.push('type   = @type');   params.type   = type;   }
  if (engine) { where.push('engine = @engine'); params.engine = engine; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = db.prepare(
    `SELECT * FROM enhanced_images ${whereClause} ORDER BY createdAt DESC LIMIT @limit OFFSET @offset`
  ).all(params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM enhanced_images ${whereClause}`
  ).get(params).n;
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function getImageCounts() {
  const r = countsStmt.get();
  return {
    queued:     r.queued || 0,
    processing: r.processing || 0,
    completed:  r.completed || 0,
    failed:     r.failed || 0,
  };
}
