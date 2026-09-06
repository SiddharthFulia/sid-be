// SQLite store for the /qr studio's Save-to-Library feature. Schema
// lives in services/aiVideo/db.js so the shared migration runner picks
// it up on boot.
//
// Owner model: no accounts. The FE sends a stable browser fingerprint
// hash as `X-QR-Owner: <hex>`; that hash is the row's owner_key. Anyone
// with the same fingerprint can list / edit / delete their rows;
// everyone can read `public=1` rows via /qr/s/:id.

import { db } from '../aiVideo/db.js';

// ─── nanoid-style slug ───────────────────────────────────────────
// 8 chars from a URL-safe alphabet gives us ~62^8 ≈ 2.18e14 possibilities
// — plenty for a personal portfolio's collision odds. We do check for
// collisions on insert and retry up to 5x, so accidental clashes bail
// out cleanly instead of silently overwriting.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function makeSlug(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// ─── Prepared statements ─────────────────────────────────────────
const insertStmt = db.prepare(`
  INSERT INTO qr_saves
    (id, owner_key, title, payload, payload_kind, style_config, png_data_url, public, views, created_at, updated_at)
  VALUES
    (@id, @owner_key, @title, @payload, @payload_kind, @style_config, @png_data_url, @public, 0, @created_at, @updated_at)
`);
const selectByIdStmt = db.prepare('SELECT * FROM qr_saves WHERE id = ?');
const selectByOwnerStmt = db.prepare(`
  SELECT * FROM qr_saves
  WHERE owner_key = ?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);
const countByOwnerStmt = db.prepare('SELECT COUNT(*) AS n FROM qr_saves WHERE owner_key = ?');
const incrementViewsStmt = db.prepare('UPDATE qr_saves SET views = views + 1 WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM qr_saves WHERE id = ? AND owner_key = ?');
const patchStmt = db.prepare(`
  UPDATE qr_saves
     SET title = COALESCE(@title, title),
         public = COALESCE(@public, public),
         updated_at = @updated_at
   WHERE id = @id AND owner_key = @owner_key
`);

// ─── Serialization ───────────────────────────────────────────────
// Rows go out as objects the FE can consume directly (JSON parsed,
// booleans instead of 0/1, plain field names). Callers should not need
// to know we're storing JSON-as-TEXT.
function rowToItem(r, { includePng = false } = {}) {
  if (!r) return null;
  let styleConfig = {};
  try { styleConfig = JSON.parse(r.style_config || '{}'); } catch {}
  return {
    id: r.id,
    title: r.title || '',
    payload: r.payload,
    payloadKind: r.payload_kind,
    styleConfig,
    // Full data URL only when a caller opted in (view page, list-with-preview).
    // Omitted from the paginated list body to keep response size sane.
    pngDataUrl: includePng ? (r.png_data_url || null) : null,
    hasPng: !!r.png_data_url,
    public: !!r.public,
    views: r.views || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Public API ──────────────────────────────────────────────────
export function createSave({
  ownerKey, title, payload, payloadKind, styleConfig, pngDataUrl, isPublic = true,
}) {
  const now = Date.now();
  // Retry a handful of times if we happen to hit a slug collision.
  for (let i = 0; i < 5; i++) {
    const id = makeSlug(8);
    try {
      insertStmt.run({
        id,
        owner_key: ownerKey,
        title: title || null,
        payload,
        payload_kind: payloadKind,
        style_config: typeof styleConfig === 'string' ? styleConfig : JSON.stringify(styleConfig || {}),
        png_data_url: pngDataUrl || null,
        public: isPublic ? 1 : 0,
        created_at: now,
        updated_at: now,
      });
      return { id, createdAt: now };
    } catch (err) {
      // UNIQUE PK violation → new slug and retry. Anything else re-throws.
      if (!/UNIQUE/i.test(String(err.message))) throw err;
    }
  }
  throw new Error('Failed to generate a unique slug after 5 attempts');
}

export function getById(id, { includePng = true } = {}) {
  return rowToItem(selectByIdStmt.get(id), { includePng });
}

export function getByIdRaw(id) {
  return selectByIdStmt.get(id) || null;
}

export function bumpViews(id) {
  incrementViewsStmt.run(id);
}

export function listByOwner({ ownerKey, limit = 30, offset = 0 }) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = selectByOwnerStmt.all(ownerKey, safeLimit, safeOffset);
  const total = countByOwnerStmt.get(ownerKey)?.n || 0;
  return {
    items: rows.map((r) => rowToItem(r, { includePng: true })),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

export function deleteSave({ id, ownerKey }) {
  const info = deleteStmt.run(id, ownerKey);
  return info.changes > 0;
}

export function patchSave({ id, ownerKey, title, isPublic }) {
  const params = {
    id,
    owner_key: ownerKey,
    title: typeof title === 'string' ? title : null,
    public: typeof isPublic === 'boolean' ? (isPublic ? 1 : 0) : null,
    updated_at: Date.now(),
  };
  const info = patchStmt.run(params);
  if (info.changes === 0) return null;
  return rowToItem(selectByIdStmt.get(id), { includePng: false });
}
