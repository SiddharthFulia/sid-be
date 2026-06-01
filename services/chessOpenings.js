// services/chessOpenings.js — ECO opening database loader.
//
// Loads ~3.7k openings from data/chess_openings.json once on first call
// and keeps the parsed array in module-local state. JSON is ~900 KB so
// the parse-on-boot cost is negligible (<50ms on a modern CPU) and the
// memory footprint is small enough to not bother with a sharded loader.
//
// Source: lichess-org/chess-openings (CC0). Pre-processed at build time
// (see scripts/build-openings.mjs — also embedded as a one-shot script
// in commands.txt) into JSON with these fields per record:
//   { eco, name, slug, pgn, moves }
//
// Public API:
//   getAll()            → entire array (cheap reference, do not mutate)
//   listOpenings(opts)  → paginated + optional name search
//   findBySlug(slug)    → single record or null
//   findByEco(eco)      → first match by ECO code (canonical name)
//   computeFen(moves)   → derive resulting FEN by replaying SAN moves
//                        via chess.js (used in the detail endpoint so
//                        the FE can hand the FEN straight to Lichess's
//                        Opening Explorer for "master games").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import logger from '../helpers/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const JSON_PATH  = path.join(__dirname, '..', 'data', 'chess_openings.json');

let _all = null;       // entire array
let _bySlug = null;    // slug → record (O(1) detail lookup)
let _byEco  = null;    // eco  → record[] (multiple variations per ECO)

function load() {
  if (_all) return _all;
  try {
    const raw = fs.readFileSync(JSON_PATH, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('openings JSON is not an array');
    _all = arr;
    _bySlug = new Map();
    _byEco  = new Map();
    for (const row of arr) {
      _bySlug.set(row.slug, row);
      if (!_byEco.has(row.eco)) _byEco.set(row.eco, []);
      _byEco.get(row.eco).push(row);
    }
    logger.info(`chessOpenings: loaded ${arr.length} entries (${(raw.length / 1024).toFixed(0)} KB)`);
    return _all;
  } catch (err) {
    logger.error(`chessOpenings: failed to load ${JSON_PATH} — ${err.message}`);
    _all = [];
    _bySlug = new Map();
    _byEco  = new Map();
    return _all;
  }
}

export function getAll() {
  return load();
}

// Paginated list with optional name / ECO substring search.
//   page  — 1-based (default 1)
//   limit — rows per page (default 50, clamped to 1..200)
//   q     — case-insensitive substring; matches against name OR eco
export function listOpenings({ page = 1, limit = 50, q = '' } = {}) {
  const all = load();
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const pg  = Math.max(1, parseInt(page, 10) || 1);
  const query = String(q || '').trim().toLowerCase();

  const filtered = !query
    ? all
    : all.filter(o =>
        o.name.toLowerCase().includes(query) ||
        o.eco.toLowerCase().includes(query));

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / lim));
  const start = (pg - 1) * lim;
  const slice = filtered.slice(start, start + lim);

  // Cheap row shape — keep the wire payload small.
  const items = slice.map(o => ({
    eco:  o.eco,
    name: o.name,
    slug: o.slug,
    plyCount: o.moves.length,
  }));

  return { items, page: pg, limit: lim, total, totalPages };
}

export function findBySlug(slug) {
  load();
  return _bySlug.get(slug) || null;
}

export function findByEco(eco) {
  load();
  const list = _byEco.get(eco);
  if (!list || !list.length) return null;
  // Canonical entry = shortest-name match (the "root" line, not a sub-variation).
  return list.slice().sort((a, b) => a.name.length - b.name.length)[0];
}

// Replay SAN moves through chess.js to derive the resulting FEN. Returns
// the standard starting FEN if `moves` is empty. Throws on illegal SAN
// (which would indicate a corrupted JSON entry — caller should 500).
export function computeFen(moves) {
  const chess = new Chess();
  for (const san of moves || []) {
    const ok = chess.move(san);
    if (!ok) throw new Error(`illegal SAN in opening: ${san}`);
  }
  return chess.fen();
}
