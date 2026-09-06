// QR Compiler saves — public shareable QR library. No auth: the caller
// sends a stable browser fingerprint hash as `X-QR-Owner: <hex>` and
// that string is treated as their identity. Anyone with the same hash
// can list / edit / delete their own rows; everyone can read rows
// marked public=1.

import {
  createSave, getById, getByIdRaw, bumpViews,
  listByOwner, deleteSave, patchSave,
} from '../../services/qrSaves/store.js';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';

const MAX_TITLE = 120;
const MAX_PAYLOAD = 4_000;                            // well over QR v40 capacity
const MAX_STYLE_CONFIG_JSON = 32_000;                 // ~32 KB of style knobs
const MAX_PNG_DATA_URL = 500 * 1024;                  // 500 KB cap on baked preview
const OWNER_KEY_RE = /^[a-f0-9]{16,128}$/i;           // SHA-256 hex or similar
const VALID_KINDS = new Set([
  'url', 'text', 'wifi', 'vcard', 'sms', 'email', 'geo', 'upi', 'kofi',
]);

function readOwnerKey(req) {
  const raw = req.get('X-QR-Owner') || req.get('x-qr-owner') || '';
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  if (!OWNER_KEY_RE.test(key)) return null;
  return key;
}

// POST /api/qr-saves
export const postCreate = (req, res) => {
  try {
    const ownerKey = readOwnerKey(req);
    if (!ownerKey) return error(res, 'X-QR-Owner header is required', 400);

    const { title, payload, payload_kind, style_config, png_data_url, public: isPublic } = req.body || {};

    if (typeof payload !== 'string' || !payload.trim()) {
      return error(res, 'payload is required', 400);
    }
    if (payload.length > MAX_PAYLOAD) {
      return error(res, `payload too long (max ${MAX_PAYLOAD} chars)`, 400);
    }
    const kind = String(payload_kind || '').toLowerCase();
    if (!VALID_KINDS.has(kind)) {
      return error(res, `payload_kind must be one of: ${[...VALID_KINDS].join(', ')}`, 400);
    }
    if (title && String(title).length > MAX_TITLE) {
      return error(res, `title too long (max ${MAX_TITLE} chars)`, 400);
    }

    // Normalise style_config to a JSON string so we can bound its size
    // and never store a broken blob.
    let styleJson;
    try {
      styleJson = typeof style_config === 'string'
        ? style_config
        : JSON.stringify(style_config || {});
    } catch {
      return error(res, 'style_config is not JSON-serializable', 400);
    }
    if (styleJson.length > MAX_STYLE_CONFIG_JSON) {
      return error(res, 'style_config too large', 400);
    }

    // PNG preview is optional — the share page can still render from
    // the payload alone, this is just a fast-path thumbnail.
    let png = null;
    if (png_data_url) {
      if (typeof png_data_url !== 'string' || !png_data_url.startsWith('data:image/')) {
        return error(res, 'png_data_url must be a data:image/... URL', 400);
      }
      if (png_data_url.length > MAX_PNG_DATA_URL) {
        return error(res, `png_data_url exceeds ${MAX_PNG_DATA_URL / 1024} KB`, 400);
      }
      png = png_data_url;
    }

    const { id } = createSave({
      ownerKey,
      title: title ? String(title).trim() : null,
      payload,
      payloadKind: kind,
      styleConfig: styleJson,
      pngDataUrl: png,
      isPublic: isPublic === undefined ? true : !!isPublic,
    });

    return success(res, { id, url: `/qr/s/${id}` }, 'Saved');
  } catch (err) {
    logger.error('qr-saves postCreate failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/qr-saves
export const getList = (req, res) => {
  try {
    const ownerKey = readOwnerKey(req);
    if (!ownerKey) return error(res, 'X-QR-Owner header is required', 400);

    const limit = parseInt(req.query.limit, 10) || 30;
    const offset = parseInt(req.query.offset, 10) || 0;

    const result = listByOwner({ ownerKey, limit, offset });
    return success(res, result);
  } catch (err) {
    logger.error('qr-saves getList failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/qr-saves/:id
// - public row: readable by anyone, bumps `views`
// - private row: only the owner (matching X-QR-Owner) can read
export const getOne = (req, res) => {
  try {
    const id = String(req.params.id || '');
    const raw = getByIdRaw(id);
    if (!raw) return error(res, 'Not found', 404);

    const ownerKey = readOwnerKey(req);
    const isOwner = ownerKey && ownerKey === raw.owner_key;
    if (!raw.public && !isOwner) return error(res, 'Not found', 404);

    // Only public-view GETs increment the counter — the owner peeking
    // at their own row from the /qr history shouldn't inflate it.
    if (!isOwner && raw.public) {
      bumpViews(id);
    }

    const item = getById(id, { includePng: true });
    return success(res, { item, isOwner });
  } catch (err) {
    logger.error('qr-saves getOne failed', err.message);
    return error(res, err.message);
  }
};

// DELETE /api/qr-saves/:id
export const deleteOne = (req, res) => {
  try {
    const ownerKey = readOwnerKey(req);
    if (!ownerKey) return error(res, 'X-QR-Owner header is required', 400);
    const id = String(req.params.id || '');
    const ok = deleteSave({ id, ownerKey });
    if (!ok) return error(res, 'Not found', 404);
    return success(res, { id }, 'Deleted');
  } catch (err) {
    logger.error('qr-saves deleteOne failed', err.message);
    return error(res, err.message);
  }
};

// PATCH /api/qr-saves/:id — owner only. Toggle public / edit title.
export const patchOne = (req, res) => {
  try {
    const ownerKey = readOwnerKey(req);
    if (!ownerKey) return error(res, 'X-QR-Owner header is required', 400);
    const id = String(req.params.id || '');

    const { title, public: isPublic } = req.body || {};
    if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE)) {
      return error(res, `title must be a string ≤ ${MAX_TITLE} chars`, 400);
    }
    if (isPublic !== undefined && typeof isPublic !== 'boolean') {
      return error(res, 'public must be a boolean', 400);
    }

    const updated = patchSave({
      id,
      ownerKey,
      title: title === undefined ? undefined : String(title).trim(),
      isPublic: isPublic === undefined ? undefined : isPublic,
    });
    if (!updated) return error(res, 'Not found', 404);
    return success(res, { item: updated }, 'Updated');
  } catch (err) {
    logger.error('qr-saves patchOne failed', err.message);
    return error(res, err.message);
  }
};
