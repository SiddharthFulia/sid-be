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
  error, bytes, workerId, createdAt, startedAt, completedAt,
  workflow, steps, denoise, cfg, width, height, customModel
) VALUES (
  @imageId, @status, @type, @engine, @presetId, @prompt, @sourceUrl, @outputUrl,
  @error, @bytes, @workerId, @createdAt, @startedAt, @completedAt,
  @workflow, @steps, @denoise, @cfg, @width, @height, @customModel
)`);

const selectStmt = db.prepare('SELECT * FROM enhanced_images WHERE imageId = ?');
const deleteStmt = db.prepare('DELETE FROM enhanced_images WHERE imageId = ?');
const nextQueuedStmt = db.prepare(
  "SELECT * FROM enhanced_images WHERE engine = 'local' AND status = 'queued' ORDER BY createdAt ASC LIMIT 1"
);
// Two count statements — one for public rows, one for vault rows. Library
// FE picks the right set based on which tab the user is viewing.
const countsAllStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status='queued'     THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing,
    SUM(CASE WHEN status='completed'  THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='failed'     THEN 1 ELSE 0 END) AS failed
  FROM enhanced_images
`);
const countsVaultStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status='queued'     THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing,
    SUM(CASE WHEN status='completed'  THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='failed'     THEN 1 ELSE 0 END) AS failed
  FROM enhanced_images
  WHERE vault = ?
`);

const COLUMNS = new Set([
  'status', 'type', 'engine', 'presetId', 'prompt', 'sourceUrl', 'outputUrl',
  'error', 'bytes', 'workerId', 'startedAt', 'completedAt',
  'workflow', 'steps', 'denoise', 'cfg', 'width', 'height', 'logs', 'customModel',
  'vault',
]);

// Append a log line to the row's `logs` JSON array. Cap at the most recent
// 80 entries to keep the column small.
const logsSelectStmt = db.prepare('SELECT logs FROM enhanced_images WHERE imageId = ?');
const logsUpdateStmt = db.prepare('UPDATE enhanced_images SET logs = ? WHERE imageId = ?');
export function appendImageLog(imageId, line) {
  const row = logsSelectStmt.get(imageId);
  if (!row) return null;
  let arr = [];
  try { arr = JSON.parse(row.logs || '[]'); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
  arr.push({ ts: Date.now(), msg: String(line).slice(0, 300) });
  if (arr.length > 80) arr = arr.slice(-80);
  logsUpdateStmt.run(JSON.stringify(arr), imageId);
  return arr;
}

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
    workflow: null,
    steps: null,
    denoise: null,
    cfg: null,
    width: null,
    height: null,
    customModel: null,
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

// Paginated list. Filter by status / type / engine / vault.
//   vault=undefined  → return both public + vault items
//   vault=0          → public items only (default for anonymous viewers)
//   vault=1          → vault items only (private, requires auth on the caller side)
export function listImages({ status, type, engine, vault, page = 1, limit = 24 } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  const where = [];
  const params = { limit, offset };
  if (status)             { where.push('status = @status'); params.status = status; }
  if (type)               { where.push('type   = @type');   params.type   = type;   }
  if (engine)             { where.push('engine = @engine'); params.engine = engine; }
  if (vault === 0 || vault === 1) {
    where.push('vault = @vault'); params.vault = vault;
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = db.prepare(
    `SELECT * FROM enhanced_images ${whereClause} ORDER BY createdAt DESC LIMIT @limit OFFSET @offset`
  ).all(params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM enhanced_images ${whereClause}`
  ).get(params).n;
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function getImageCounts(vault) {
  // vault = undefined → all rows; 0 → public only; 1 → vault only
  const r = vault === 0 || vault === 1
    ? countsVaultStmt.get(vault)
    : countsAllStmt.get();
  return {
    queued:     r?.queued || 0,
    processing: r?.processing || 0,
    completed:  r?.completed || 0,
    failed:     r?.failed || 0,
  };
}
