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
//   getAll()              → entire array (cheap reference, do not mutate)
//   listOpenings(opts)    → paginated + optional name search
//   findBySlug(slug)      → single record or null
//   findByEco(eco)        → first match by ECO code (canonical name)
//   computeFen(moves)     → derive resulting FEN by replaying SAN moves
//                          via chess.js (used in the detail endpoint so
//                          the FE can hand the FEN straight to Lichess's
//                          Opening Explorer for "master games").
//   identifyOpening(moves) → live name-the-line lookup; given the SAN
//                          history of a game-in-progress, returns the
//                          most-specific opening whose moves[] is a
//                          literal prefix of the input. Powers the
//                          /chess opening heading that updates after
//                          every ply. Pure read, nothing persisted.

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
// Prefix index — keyed by the joined SAN sequence ('e4|c5|Nf3'), value
// is an array of opening indices into _all whose `moves` ARE exactly
// that prefix. identifyOpening() walks the input prefix-by-prefix and
// remembers the deepest hit. ~3.7k entries → ~3.7k Map keys at load.
let _prefixIndex = null;

function load() {
  if (_all) return _all;
  try {
    const raw = fs.readFileSync(JSON_PATH, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('openings JSON is not an array');
    _all = arr;
    _bySlug = new Map();
    _byEco  = new Map();
    _prefixIndex = new Map();
    for (let i = 0; i < arr.length; i++) {
      const row = arr[i];
      _bySlug.set(row.slug, row);
      if (!_byEco.has(row.eco)) _byEco.set(row.eco, []);
      _byEco.get(row.eco).push(row);
      // Index by the opening's full ply sequence. Multiple openings can
      // share a key when their move lists are literally identical (e.g.
      // transpositions named differently across ECO codes); we keep
      // them in a flat list and tie-break at lookup time.
      const key = (row.moves || []).join('|');
      if (!_prefixIndex.has(key)) _prefixIndex.set(key, []);
      _prefixIndex.get(key).push(i);
    }
    logger.info(`chessOpenings: loaded ${arr.length} entries (${(raw.length / 1024).toFixed(0)} KB), prefix index keys=${_prefixIndex.size}`);
    return _all;
  } catch (err) {
    logger.error(`chessOpenings: failed to load ${JSON_PATH} — ${err.message}`);
    _all = [];
    _bySlug = new Map();
    _byEco  = new Map();
    _prefixIndex = new Map();
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

// Diagnostic — number of distinct prefix keys held in the in-memory
// index. Useful for the boot log + any future /chess/status surface.
export function prefixIndexSize() {
  load();
  return _prefixIndex ? _prefixIndex.size : 0;
}

// Live opening identifier — given the moves played so far, return the
// most-specific opening whose `moves` array is a literal prefix of the
// input. Walks the input ply-by-ply and remembers the deepest hit.
//
//   moves — string[] of SAN tokens, e.g. ['e4','c5','Nf3','d6','d4']
//
// Returns:
//   { eco, name, slug, matchedPly, candidates? }
//     • matchedPly = number of plies the matched opening covers.
//     • candidates is only set when ≥2 openings share that depth — the
//       FE can use it as a "could also be …" hint. The picked record is
//       the first by lexicographic name to keep selection stable.
//   null — when no opening matches the input at any depth (e.g. the
//     game went out of book on move 1, or moves[0] is illegal SAN).
export function identifyOpening(moves) {
  load();
  if (!Array.isArray(moves) || moves.length === 0) return null;
  if (!_prefixIndex || _prefixIndex.size === 0) return null;

  // Build the running prefix key once per call and probe the Map at
  // every depth. O(input.length) work, single allocation per slice.
  let key = '';
  let bestDepth = 0;
  let bestHits = null;
  const maxPly = moves.length;
  for (let i = 0; i < maxPly; i++) {
    const san = moves[i];
    if (typeof san !== 'string' || !san) break;
    key = i === 0 ? san : `${key}|${san}`;
    const hits = _prefixIndex.get(key);
    if (hits && hits.length) {
      // Always upgrade — deeper prefix means more specific opening.
      bestDepth = i + 1;
      bestHits = hits;
    }
  }
  if (!bestHits) return null;

  // Tie-break: lexicographic by name. Stable across calls and avoids
  // surprises like a transposition flipping the displayed name mid-game.
  const rows = bestHits.map(idx => _all[idx]).sort((a, b) => a.name.localeCompare(b.name));
  const picked = rows[0];
  const out = {
    eco:        picked.eco,
    name:       picked.name,
    slug:       picked.slug,
    matchedPly: bestDepth,
  };
  if (rows.length > 1) {
    out.candidates = rows.slice(0, 8).map(r => ({ eco: r.eco, name: r.name, slug: r.slug }));
  }
  return out;
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
