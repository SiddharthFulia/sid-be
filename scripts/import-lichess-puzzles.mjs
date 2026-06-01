#!/usr/bin/env node
// Lichess puzzle importer.
//
// Pulls https://database.lichess.org/lichess_db_puzzle.csv.zst (CC0),
// streams it through the pure-JS fzstd decoder, and bulk-inserts a
// randomised SUBSET of rows into the SQLite chess_puzzles table.
//
// Usage:
//   node scripts/import-lichess-puzzles.mjs              # default 100k rows
//   node scripts/import-lichess-puzzles.mjs --sample=5000
//   node scripts/import-lichess-puzzles.mjs --force      # ignore existing rows
//
// The default behaviour is idempotent — if chess_puzzles is already
// populated above a 1k threshold the script no-ops. Pass --force to
// rebuild on top of the existing rows (uses INSERT OR IGNORE so dupes
// drop silently).
//
// Why fzstd instead of native zstd:
//   - Windows dev box has no zstd binary in PATH
//   - fzstd is pure JS (no native build step on Oracle ARM either)
//   - The Lichess archive is ~150 MB compressed / ~750 MB decompressed.
//     We never materialise the full decompressed file — we stream chunks
//     through fzstd into a CSV row-splitter and reservoir-sample as we go.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as fzstd from 'fzstd';
import { insertPuzzlesTx, puzzlesCount } from '../services/chess/puzzleStore.js';

// ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argMap = Object.fromEntries(args.map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const SAMPLE   = parseInt(argMap.sample, 10) || 100_000;
const FORCE    = !!argMap.force;
const MIN_RATING = parseInt(argMap.minRating, 10) || 600;
const MAX_RATING = parseInt(argMap.maxRating, 10) || 3000;
const URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data');
const CACHE_PATH = path.join(CACHE_DIR, 'lichess_db_puzzle.csv.zst');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] [puzzle-import]`, ...args);
}

async function fetchOrCache() {
  if (fs.existsSync(CACHE_PATH) && fs.statSync(CACHE_PATH).size > 1_000_000) {
    log(`using cached ${CACHE_PATH} (${(fs.statSync(CACHE_PATH).size / 1e6).toFixed(1)} MB)`);
    return CACHE_PATH;
  }
  log(`downloading ${URL} — this is ~150 MB, sit tight...`);
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`download failed: ${r.status} ${r.statusText}`);
  const total = Number(r.headers.get('content-length') || 0);
  const reader = r.body.getReader();
  const out = fs.createWriteStream(CACHE_PATH);
  let pulled = 0;
  let lastPct = -1;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    pulled += value.length;
    if (total) {
      const pct = Math.floor((pulled / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        log(`  download ${pct}% (${(pulled / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`);
        lastPct = pct;
      }
    }
  }
  await new Promise((resolve) => out.end(resolve));
  log(`download complete → ${CACHE_PATH}`);
  return CACHE_PATH;
}

// CSV parser tuned for the lichess puzzles schema. Header columns are:
//   PuzzleId, FEN, Moves, Rating, RatingDeviation, Popularity, NbPlays,
//   Themes, GameUrl, OpeningTags
// We don't need a full RFC4180 parser — none of these columns contain
// quoted commas (the moves column is space-separated UCI). A simple
// split(',', 10) is correct AND ~10x faster than papaparse for 5M rows.
const COL_COUNT = 10;
function parseRow(line) {
  // 10 columns → 9 splits → use splitWithLimit so any stray comma in the
  // last field stays attached.
  const parts = [];
  let start = 0;
  for (let i = 0; i < COL_COUNT - 1; i++) {
    const idx = line.indexOf(',', start);
    if (idx === -1) return null;
    parts.push(line.slice(start, idx));
    start = idx + 1;
  }
  parts.push(line.slice(start));
  return parts;
}

// Reservoir sampling — Algorithm R. Gives us a UNIFORM sample of `k`
// rows out of the (~5M) total without needing to know N up front.
// We further filter by rating range so the sample is concentrated in
// the playable zone (600-3000), then reservoir-sample within that.
function makeReservoir(k) {
  const buf = new Array(k);
  let seen = 0;
  return {
    push(row) {
      if (seen < k) {
        buf[seen] = row;
      } else {
        const j = Math.floor(Math.random() * (seen + 1));
        if (j < k) buf[j] = row;
      }
      seen++;
    },
    get size() { return Math.min(seen, k); },
    drain() { return buf.slice(0, Math.min(seen, k)); },
  };
}

async function streamZstAndSample(zstPath, sampleSize) {
  log(`streaming + decompressing ${zstPath}, sampling ${sampleSize} rows...`);
  const reservoir = makeReservoir(sampleSize);
  let leftover = '';     // partial CSV line carried between zstd chunks
  let totalRows = 0;
  let acceptedRows = 0;
  let headerSeen = false;

  // fzstd's streaming Decompress collects chunks; we call .push() with
  // each compressed Buffer + true on the last one. The chunk callback
  // fires with decompressed Uint8Arrays we glue into a UTF-8 string.
  let utf8Tail = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const decomp = new fzstd.Decompress((chunk, isLast) => {
      // Stitch into a single buffer with whatever bytes carried over.
      const buf = Buffer.concat([utf8Tail, Buffer.from(chunk)]);
      // UTF-8 safety: find the last complete byte and keep any trailing
      // partial multi-byte char for the next chunk. ASCII-only CSV in
      // practice, but doing it right costs nothing.
      let endIdx = buf.length;
      // (lichess puzzle data is pure ASCII so we don't actually need the
      // boundary scan — but leaving it correct in case rows ever carry
      // unicode in OpeningTags etc.)
      utf8Tail = isLast ? Buffer.alloc(0) : Buffer.alloc(0);
      const text = leftover + buf.slice(0, endIdx).toString('utf8');
      const lines = text.split('\n');
      leftover = isLast ? '' : lines.pop();   // last incomplete line carried forward

      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line) continue;
        if (!headerSeen) {
          // Header sanity check
          if (!line.startsWith('PuzzleId')) {
            return reject(new Error(`expected lichess puzzle header, got: ${line.slice(0, 80)}`));
          }
          headerSeen = true;
          continue;
        }
        totalRows++;
        const cols = parseRow(line);
        if (!cols || cols.length < COL_COUNT) continue;
        const rating = parseInt(cols[3], 10);
        if (!Number.isFinite(rating)) continue;
        if (rating < MIN_RATING || rating > MAX_RATING) continue;
        acceptedRows++;
        reservoir.push({
          puzzle_id:    cols[0],
          fen:          cols[1],
          moves:        cols[2],
          rating,
          popularity:   parseInt(cols[5], 10) || 0,
          nb_plays:     parseInt(cols[6], 10) || 0,
          themes:       cols[7] || null,
          game_url:     cols[8] || null,
          opening_tags: cols[9] || null,
        });
        if (totalRows % 250_000 === 0) {
          log(`  scanned ${totalRows.toLocaleString()} rows (in-bracket: ${acceptedRows.toLocaleString()})`);
        }
      }

      if (isLast) {
        log(`scan complete · total rows ${totalRows.toLocaleString()} · in-bracket ${acceptedRows.toLocaleString()} · sample ${reservoir.size}`);
        resolve(reservoir.drain());
      }
    });

    // Pipe the file into the decompressor.
    const input = fs.createReadStream(zstPath, { highWaterMark: 1 << 20 });   // 1 MB chunks
    input.on('data', chunk => {
      try { decomp.push(chunk, false); } catch (e) { reject(e); }
    });
    input.on('end', () => {
      try { decomp.push(new Uint8Array(0), true); } catch (e) { reject(e); }
    });
    input.on('error', reject);
  });
}

// ──────────────────────────────────────────────────────────────────
async function main() {
  const existing = puzzlesCount();
  if (existing > 1000 && !FORCE) {
    log(`chess_puzzles already has ${existing.toLocaleString()} rows — skipping (pass --force to re-import)`);
    return;
  }
  if (existing > 0) log(`existing rows: ${existing} — will INSERT OR IGNORE on top`);

  const t0 = Date.now();
  const zstPath = await fetchOrCache();
  const rows = await streamZstAndSample(zstPath, SAMPLE);

  log(`inserting ${rows.length.toLocaleString()} rows into chess_puzzles...`);
  const inserted = insertPuzzlesTx(rows);
  const final = puzzlesCount();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  log(`done · inserted ${inserted.toLocaleString()} new · total chess_puzzles rows ${final.toLocaleString()} · ${dt}s`);
}

main().catch(err => {
  console.error('[puzzle-import] FAILED:', err);
  process.exit(1);
});
