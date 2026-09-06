// City road-graph cache. Shared SQLite store so a graph is fetched from
// Overpass exactly once per city and then served to every visitor from
// local disk (gzipped, ~1-3 MB compressed for ~10-20k node metro cores).
//
// Why server-side SQLite (and not FE IndexedDB / server RAM):
//   • IndexedDB is per-browser — cold start on every new device
//   • Server RAM is per-restart — PM2 reload = re-fetch = Overpass abuse
//   • SQLite BLOB is O(1) lookup, gzip'd row, survives restarts, one file
//     backup covers every city, and one process owns the rate limit
//
// Endpoints:
//   GET  /api/city-graphs                — public, metadata only (no payload)
//   GET  /api/city-graphs/:slug          — public, returns {nodes, edges}
//                                          (fetches from Overpass if missing;
//                                          also silently refreshes if the row
//                                          is > 30 days old — see AUTO_REFRESH_MS)
//   GET  /api/city-graphs/:slug/places   — public, fuzzy search for area names
//                                          (Trie + trigram + substring, lazy
//                                          per city). Returns {name, kind,
//                                          lat, lng, score, matchType}.
//   GET  /api/city-graphs/places         — public, cross-city fuzzy search
//                                          (fallback for the "search all"
//                                          mode). Adds city_slug/city_name.
//   POST /api/city-graphs/:slug/refresh  — vault-gated, forces re-fetch
//
// Overpass rate-limit is polite:
//   • one hit per city per 30 days from the public GET path (auto-refresh)
//   • the refresh endpoint bypasses this check but requires vault

import { promisify } from 'node:util';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { db } from '../../services/aiVideo/db.js';
import { tokenize, trigrams, overlap, phraseTrigrams } from '../../services/search/trigram.js';

const gzip   = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// ── Schema ─────────────────────────────────────────────────────────
// Kept next to the controller — every domain in this codebase declares
// its own CREATE TABLE IF NOT EXISTS at module load, matching the
// aiVideo/db.js house style. Slug is the PK.
db.exec(`
  CREATE TABLE IF NOT EXISTS city_graphs (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    bbox        TEXT NOT NULL,        -- 'south,west,north,east'
    center_lat  REAL NOT NULL,
    center_lng  REAL NOT NULL,
    graph       BLOB NOT NULL,        -- gzipped JSON {nodes, edges}
    node_count  INTEGER NOT NULL,
    edge_count  INTEGER NOT NULL,
    fetched_at  INTEGER NOT NULL,     -- unix ms
    bytes       INTEGER NOT NULL      -- gzipped size
  );
`);

// ── Migrations — additive columns for created_at / updated_at ────
// Idempotent — SQLite doesn't have IF NOT EXISTS on ALTER TABLE, so we
// probe the pragma first. `bytes` was in the original create; the two
// timestamps are new.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('city_graphs', 'created_at', 'INTEGER');
ensureColumn('city_graphs', 'updated_at', 'INTEGER');

// Backfill so rows written before the migration land in a valid state.
db.exec(`
  UPDATE city_graphs SET created_at = fetched_at WHERE created_at IS NULL;
  UPDATE city_graphs SET updated_at = fetched_at WHERE updated_at IS NULL;
`);

// ── Places table + index ───────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS city_places (
    id          INTEGER PRIMARY KEY,
    city_slug   TEXT NOT NULL,
    name        TEXT NOT NULL,
    name_lc     TEXT NOT NULL,
    kind        TEXT,
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_city_places_slug_name ON city_places(city_slug, name_lc);
`);

// ── Auxiliary indexes ──────────────────────────────────────────────
// Idempotent (IF NOT EXISTS). Added to support the monthly re-fetch cron
// and admin dashboards:
//   • updated_at / fetched_at on city_graphs — "which cities are stalest?"
//     range scans for the admin table + the cron's freshness report.
//   • kind on city_places — cheap filter for the FE map overlay when we
//     want to show only landmarks vs suburbs.
//   • (lat, lng) on city_places — enables spatial bbox queries without a
//     full table scan when we later render clusters.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_city_graphs_updated_at ON city_graphs(updated_at);
  CREATE INDEX IF NOT EXISTS idx_city_graphs_fetched_at ON city_graphs(fetched_at);
  CREATE INDEX IF NOT EXISTS idx_city_places_kind      ON city_places(kind);
  CREATE INDEX IF NOT EXISTS idx_city_places_lat_lng   ON city_places(lat, lng);
  -- Bare column index — complements the composite (city_slug, name_lc)
  -- above and speeds the cross-city fuzzy search (no city_slug filter,
  -- but we still need name_lc lookups to short-circuit the scan).
  CREATE INDEX IF NOT EXISTS idx_city_places_name_lc   ON city_places(name_lc);
`);

// ── Seed catalogue ─────────────────────────────────────────────────
// The 10 metros we preseed via scripts/seedCityGraphs.js. Every entry
// here is also what surfaces from the metadata list endpoint even
// before the row is populated — so the FE can render the picker with
// disabled states for "not fetched yet" cities.
export const CITY_CATALOG = [
  { slug: 'bangalore', name: 'Bangalore', bbox: '12.85,77.45,13.10,77.75', center: { lat: 12.9716, lng: 77.5946 } },
  { slug: 'mumbai',    name: 'Mumbai',    bbox: '18.90,72.75,19.30,73.05', center: { lat: 19.0760, lng: 72.8777 } },
  { slug: 'delhi',     name: 'Delhi',     bbox: '28.45,76.90,28.85,77.35', center: { lat: 28.6139, lng: 77.2090 } },
  { slug: 'chennai',   name: 'Chennai',   bbox: '12.90,80.15,13.20,80.30', center: { lat: 13.0827, lng: 80.2707 } },
  { slug: 'hyderabad', name: 'Hyderabad', bbox: '17.30,78.30,17.55,78.60', center: { lat: 17.3850, lng: 78.4867 } },
  { slug: 'kolkata',   name: 'Kolkata',   bbox: '22.45,88.25,22.65,88.45', center: { lat: 22.5726, lng: 88.3639 } },
  { slug: 'pune',      name: 'Pune',      bbox: '18.45,73.75,18.65,73.95', center: { lat: 18.5204, lng: 73.8567 } },
  { slug: 'ahmedabad', name: 'Ahmedabad', bbox: '23.00,72.50,23.15,72.65', center: { lat: 23.0225, lng: 72.5714 } },
  { slug: 'jaipur',    name: 'Jaipur',    bbox: '26.80,75.70,27.00,75.90', center: { lat: 26.9124, lng: 75.7873 } },
  { slug: 'lucknow',   name: 'Lucknow',   bbox: '26.75,80.85,26.95,81.05', center: { lat: 26.8467, lng: 80.9462 } },
];

const CATALOG_BY_SLUG = new Map(CITY_CATALOG.map((c) => [c.slug, c]));

// ── Overpass ───────────────────────────────────────────────────────
// Multiple mirrors — try each in order on 5xx / timeout / truncation.
// Main instance overloads fastest; kumi + private.coffee are the community
// mirrors and are usually quieter. `z.overpass-api.de` is a shard of the
// main pool that occasionally has spare capacity when the primary is red.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

// Auto-refresh cadence for /:slug GETs — anything older than 30 days
// triggers a background re-fetch on the next request. First responder
// gets the stale row; the refresh writes in the background.
const AUTO_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

// Build the QL query for a given bbox string 'south,west,north,east'.
// We ask for the standard highway hierarchy plus residential /
// living_street so smaller streets are drawable inside a metro core.
function buildOverpassQL(bbox) {
  return `[out:json][timeout:60];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](${bbox});
(._;>;);
out body;`;
}

// Places query — suburbs, neighbourhoods, quarters, squares, small
// towns/villages within the metro bbox, plus tourist attractions so
// well-known landmarks are searchable ("Cubbon Park", "Vidhana Soudha").
function buildPlacesQL(bbox) {
  return `[out:json][timeout:60];
(
  node["place"~"^(suburb|neighbourhood|quarter|square|town|village)$"](${bbox});
  node["tourism"="attraction"](${bbox});
);
out body;`;
}

// Parse Overpass response into a compact {nodes, edges} shape suitable
// for storing as JSON. Nodes: [id, lat, lng] triplets. Edges: [from,
// to, weightMeters] triplets — oneway=yes ways emit a single directed
// edge; everything else emits both directions.
//
// We use haversine on the server so the FE doesn't need to recompute
// edge weights on load. Rounding to 1 m keeps the JSON smaller.
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const la1 = toRad(lat1), la2 = toRad(lat2);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function parseOverpass(json) {
  const nodePos = new Map();       // id -> {lat, lng}
  const nodes = [];
  const edges = [];

  for (const el of json.elements || []) {
    if (el.type === 'node') {
      nodePos.set(el.id, { lat: el.lat, lng: el.lon });
    }
  }
  for (const [id, n] of nodePos) {
    nodes.push([id, n.lat, n.lng]);
  }
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.nodes)) continue;
    const t = el.tags || {};
    const oneway = t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1';
    for (let i = 0; i < el.nodes.length - 1; i++) {
      const a = el.nodes[i], b = el.nodes[i + 1];
      const na = nodePos.get(a), nb = nodePos.get(b);
      if (!na || !nb) continue;
      const w = Math.round(haversine(na.lat, na.lng, nb.lat, nb.lng));
      edges.push([a, b, w]);
      if (!oneway) edges.push([b, a, w]);
    }
  }
  return { nodes, edges };
}

// Extract [{name, kind, lat, lng}] from Overpass places JSON. We de-dupe
// by (name_lc, coarse_lat, coarse_lng) so a suburb tagged under two
// close boundaries doesn't insert twice.
function parsePlaces(json) {
  const out = [];
  const seen = new Set();
  for (const el of json.elements || []) {
    if (el.type !== 'node') continue;
    const t = el.tags || {};
    const name = t.name || t['name:en'];
    if (!name) continue;
    let kind = null;
    if (t.place)   kind = t.place;
    else if (t.tourism === 'attraction') kind = 'landmark';
    if (!kind) continue;
    const lat = el.lat, lng = el.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const key = `${name.toLowerCase()}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind, lat, lng });
  }
  return out;
}

// Hit Overpass with mirror-fallback + retry. We POST the QL body
// form-urlencoded — same shape the FE used before we moved this call
// server-side. Node 18+ has native fetch.
//
// Failure modes we've seen in prod:
//   • 504 / 429 — mirror is overloaded. Retry a different mirror.
//   • JSON parse error — response stream got truncated mid-payload
//     (upstream closed the socket early). Also worth retrying on a
//     different mirror because the successful one might have full
//     capacity while the flaky one is streaming corrupted bytes.
//   • 400 with "runtime error: Query timed out" body — the query
//     itself is too big for the mirror's per-slot budget. Retry.
//
// We read the body as text before JSON.parse so we can distinguish
// "network truncation" from "endpoint returned HTML error page".
async function overpassPost(qlBody) {
  const body = new URLSearchParams({ data: qlBody }).toString();
  const errors = [];

  for (let attempt = 0; attempt < OVERPASS_MIRRORS.length; attempt++) {
    const url = OVERPASS_MIRRORS[attempt];
    try {
      const controller = new AbortController();
      // Match the QL's own `timeout:60` + a bit of slack for the stream.
      const timer = setTimeout(() => controller.abort(), 120_000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'sid-be city-graphs cache (+https://siddharthfulia.com)',
            Accept: 'application/json',
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        // Truncated payload — text ends mid-object.
        throw new Error(`truncated JSON at ${text.length} bytes (${e.message.slice(0, 80)})`);
      }
      if (!json || !Array.isArray(json.elements)) {
        throw new Error(`unexpected shape (no elements[])`);
      }
      if (attempt > 0) {
        // Note which mirror actually served us so we can spot rotation trends.
        logger.warn(`overpass: succeeded on mirror #${attempt + 1} after ${attempt} failure(s)`);
      }
      return json;
    } catch (err) {
      errors.push(`${url.split('/')[2]}: ${err.message}`);
      // Small back-off between mirrors so we don't hammer the pool.
      if (attempt < OVERPASS_MIRRORS.length - 1) {
        await new Promise((r) => setTimeout(r, 3000 + attempt * 2000));
      }
    }
  }
  throw new Error(`Overpass — all mirrors failed. ${errors.join(' | ')}`);
}

async function fetchFromOverpass(bbox) {
  const json = await overpassPost(buildOverpassQL(bbox));
  return parseOverpass(json);
}

async function fetchPlacesFromOverpass(bbox) {
  const json = await overpassPost(buildPlacesQL(bbox));
  return parsePlaces(json);
}

// ── Storage helpers ────────────────────────────────────────────────
function selectMeta(slug) {
  return db.prepare(`
    SELECT slug, name, bbox, center_lat, center_lng, node_count, edge_count,
           fetched_at, bytes, created_at, updated_at
      FROM city_graphs WHERE slug = ?
  `).get(slug);
}

function selectRow(slug) {
  return db.prepare(`
    SELECT slug, name, bbox, center_lat, center_lng, graph, node_count,
           edge_count, fetched_at, bytes, created_at, updated_at
      FROM city_graphs WHERE slug = ?
  `).get(slug);
}

// UPSERT keyed on slug. `created_at` is preserved on conflict — only
// the first write for a slug sets it. `updated_at` is set every write.
const upsertStmt = db.prepare(`
  INSERT INTO city_graphs (slug, name, bbox, center_lat, center_lng, graph,
                           node_count, edge_count, fetched_at, bytes,
                           created_at, updated_at)
  VALUES (@slug, @name, @bbox, @center_lat, @center_lng, @graph,
          @node_count, @edge_count, @fetched_at, @bytes,
          @created_at, @updated_at)
  ON CONFLICT(slug) DO UPDATE SET
    name       = excluded.name,
    bbox       = excluded.bbox,
    center_lat = excluded.center_lat,
    center_lng = excluded.center_lng,
    graph      = excluded.graph,
    node_count = excluded.node_count,
    edge_count = excluded.edge_count,
    fetched_at = excluded.fetched_at,
    bytes      = excluded.bytes,
    updated_at = excluded.updated_at
`);

const upsertPlaceStmt = db.prepare(`
  INSERT INTO city_places (city_slug, name, name_lc, kind, lat, lng, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const countPlacesStmt = db.prepare(`SELECT COUNT(*) AS n FROM city_places WHERE city_slug = ?`);
const deletePlacesStmt = db.prepare(`DELETE FROM city_places WHERE city_slug = ?`);
const selectPlacesStmt = db.prepare(`
  SELECT id, name, name_lc, kind, lat, lng FROM city_places WHERE city_slug = ?
`);

// Fetch, compress, write. Returns the freshly-stored row.
export async function fetchAndStoreCity(slug) {
  const spec = CATALOG_BY_SLUG.get(slug);
  if (!spec) throw new Error(`Unknown city slug: ${slug}`);
  logger.info(`city-graphs: fetching Overpass for ${slug} (${spec.bbox})`);
  const t0 = Date.now();
  const graph = await fetchFromOverpass(spec.bbox);
  const json = JSON.stringify(graph);
  const blob = await gzip(Buffer.from(json, 'utf8'));
  const now = Date.now();
  const existing = selectMeta(slug);
  upsertStmt.run({
    slug,
    name: spec.name,
    bbox: spec.bbox,
    center_lat: spec.center.lat,
    center_lng: spec.center.lng,
    graph: blob,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    fetched_at: now,
    bytes: blob.length,
    created_at: existing?.created_at || now,
    updated_at: now,
  });
  logger.info(
    `city-graphs: stored ${slug} — nodes=${graph.nodes.length} edges=${graph.edges.length} ` +
    `gz=${(blob.length / 1024).toFixed(1)} KB in ${Date.now() - t0} ms`,
  );
  // Also warm the place list on first fetch (idempotent — skips if the
  // city already has ≥ MIN_PLACES rows). Non-fatal on failure — the road
  // graph still lands even if places time out.
  try {
    await ensurePlacesForCity(slug);
  } catch (err) {
    logger.warn(`city-graphs: places seed for ${slug} failed (non-fatal): ${err.message}`);
  }
  return selectMeta(slug);
}

// ── Places seeding + Trie ──────────────────────────────────────────
// Minimum number of places we consider "seeded". Below this we assume
// the last seed failed / was partial and re-hit Overpass.
const MIN_PLACES = 10;

export async function ensurePlacesForCity(slug, { force = false } = {}) {
  const spec = CATALOG_BY_SLUG.get(slug);
  if (!spec) throw new Error(`Unknown city slug: ${slug}`);
  if (!force) {
    const { n } = countPlacesStmt.get(slug);
    if (n >= MIN_PLACES) return { seeded: false, count: n };
  }
  const places = await fetchPlacesFromOverpass(spec.bbox);
  const now = Date.now();
  const tx = db.transaction((rows) => {
    if (force) deletePlacesStmt.run(slug);
    for (const p of rows) {
      upsertPlaceStmt.run(slug, p.name, p.name.toLowerCase(), p.kind, p.lat, p.lng, now, now);
    }
  });
  tx(places);
  // Invalidate the cached Trie for this city so the next search
  // rebuilds from fresh rows.
  trieCache.delete(slug);
  logger.info(`city-graphs: seeded ${places.length} places for ${slug}`);
  return { seeded: true, count: places.length };
}

// Trie backed by contiguous arrays of small objects — cheap to build,
// O(k) prefix walks where k = length of the query. Value nodes store an
// array of place indexes so we can rank later.
class Trie {
  constructor() {
    // root: { children: Map<char, node>, indexes: [] }
    this.root = { children: new Map(), indexes: [] };
    this.places = [];
  }
  insert(place, idx) {
    // Insert every whitespace-separated token so multi-word names like
    // "Cubbon Park" are searchable by either "cubb" or "park".
    const tokens = place.name_lc.split(/[\s\-_/,]+/).filter(Boolean);
    // Also index the full lowercased name as one token (covers hyphens
    // in the token split loop above being aggressive).
    const all = new Set([place.name_lc, ...tokens]);
    for (const tok of all) {
      let node = this.root;
      for (let i = 0; i < tok.length; i++) {
        const ch = tok[i];
        let next = node.children.get(ch);
        if (!next) { next = { children: new Map(), indexes: [] }; node.children.set(ch, next); }
        node = next;
        if (i >= 1) node.indexes.push(idx);   // start collecting after 2 chars
      }
    }
  }
  // Prefix walk. Returns unique matching place indexes, sliced to limit.
  search(prefix, limit) {
    const q = prefix.toLowerCase().trim();
    if (!q) return [];
    let node = this.root;
    for (const ch of q) {
      const next = node.children.get(ch);
      if (!next) return [];
      node = next;
    }
    const seen = new Set();
    const out = [];
    for (const idx of node.indexes) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
      if (out.length >= limit) break;
    }
    return out;
  }
}

// Slug -> { trie, trigrams, rows, rowTrigrams }. Built lazily on first
// search per city; invalidated when places for that city are re-seeded.
//
// Shape:
//   trie         — prefix walker (existing)
//   rows         — the raw place rows for this city, indexable by idx
//   rowTrigrams  — parallel array of Set<string> — the trigram bag for
//                  each row's full name (used for scoring)
//   trigrams     — inverted index Map<3gram, Set<idx>> — quick "which
//                  rows share ANY trigram with my query token" lookup
//                  so we don't scan the full row list on every query
const trieCache = new Map();

function buildIndexRows(rows) {
  const rowTrigrams = new Array(rows.length);
  const invIndex = new Map(); // 3gram -> Set<idx>
  for (let i = 0; i < rows.length; i++) {
    const bag = phraseTrigrams(rows[i].name);
    rowTrigrams[i] = bag;
    for (const g of bag) {
      let set = invIndex.get(g);
      if (!set) { set = new Set(); invIndex.set(g, set); }
      set.add(i);
    }
  }
  return { rowTrigrams, trigrams: invIndex };
}

function getIndexFor(slug) {
  if (trieCache.has(slug)) return trieCache.get(slug);
  const rows = selectPlacesStmt.all(slug);
  const trie = new Trie();
  trie.places = rows;
  for (let i = 0; i < rows.length; i++) trie.insert(rows[i], i);
  const { rowTrigrams, trigrams: invIndex } = buildIndexRows(rows);
  const entry = { trie, rows, rowTrigrams, trigrams: invIndex };
  trieCache.set(slug, entry);
  return entry;
}

// ── Fuzzy ranking ──────────────────────────────────────────────────
// Google-Maps style: prefix and substring hits beat pure trigram hits;
// exact match trumps everything. Scores capped so a heavy substring hit
// never outranks a genuine exact match.
//
//   exact match on the full name (case-insensitive)     → 100
//   any tokenised prefix hit (Trie)                     →  90
//   substring hit anywhere in name                      →  70
//   pure trigram overlap (Dice)                         →  60 * dice
//
// The output is a Map<idx, {score, matchType}> so caller can dedupe by
// idx and re-rank on the strongest signal per row.
function scoreQueryAgainstIndex(entry, q) {
  const scored = new Map(); // idx -> { score, matchType }
  const bump = (idx, score, matchType) => {
    const prev = scored.get(idx);
    if (!prev || score > prev.score) scored.set(idx, { score, matchType });
  };

  const qTrim = q.trim();
  if (!qTrim) return scored;
  const qLc = qTrim.toLowerCase();
  const tokens = tokenize(qTrim);

  // 1) Exact match on full lowercased name.
  for (let i = 0; i < entry.rows.length; i++) {
    if (entry.rows[i].name_lc === qLc) bump(i, 100, 'exact');
  }

  // 2) Prefix hits — walk the Trie per token. Trie.search already
  //    handles multi-token names (each token was inserted separately).
  for (const tok of tokens) {
    const idxs = entry.trie.search(tok, 500);
    for (const i of idxs) bump(i, 90, 'prefix');
  }

  // 3) Substring hits — cheap pass through all rows. Row count per
  //    city is small (< a few hundred) so this is O(n·q) and fine.
  for (let i = 0; i < entry.rows.length; i++) {
    const nlc = entry.rows[i].name_lc;
    if (nlc.includes(qLc)) { bump(i, 70, 'substring'); continue; }
    // Also try individual tokens so "cubbon park" query hits a row
    // whose name is just "Cubbon Park (Bandstand)" without needing
    // the exact ordering.
    for (const tok of tokens) {
      if (tok.length >= 3 && nlc.includes(tok)) { bump(i, 70, 'substring'); break; }
    }
  }

  // 4) Trigram overlap — narrows to a candidate set via the inverted
  //    index (rows that share ANY 3gram with the query), then Dice-
  //    scores each candidate against the query's full trigram bag.
  const qBag = phraseTrigrams(qTrim);
  if (qBag.size) {
    const candidates = new Set();
    for (const g of qBag) {
      const hit = entry.trigrams.get(g);
      if (hit) for (const i of hit) candidates.add(i);
    }
    for (const i of candidates) {
      const dice = overlap(qBag, entry.rowTrigrams[i]);
      if (dice > 0) bump(i, Math.round(60 * dice), 'trigram');
    }
  }

  return scored;
}

// ── Handlers ───────────────────────────────────────────────────────

// GET /api/city-graphs
// Metadata list for the FE picker. Merges the catalog (10 known cities)
// with whatever's actually in the DB — so unfetched cities show up too
// with fetched_at=null and node_count=0.
export const listCities = (_req, res) => {
  try {
    const stored = new Map();
    for (const r of db.prepare(`
      SELECT slug, name, bbox, center_lat, center_lng, node_count, edge_count,
             fetched_at, bytes FROM city_graphs
    `).all()) {
      stored.set(r.slug, r);
    }
    const items = CITY_CATALOG.map((c) => {
      const r = stored.get(c.slug);
      return {
        slug: c.slug,
        name: c.name,
        bbox: c.bbox,
        center: c.center,
        node_count: r?.node_count ?? 0,
        edge_count: r?.edge_count ?? 0,
        fetched_at: r?.fetched_at ?? null,
        kb:         r?.bytes ? Math.round(r.bytes / 1024) : 0,
        cached:     !!r,
      };
    });
    return success(res, { items });
  } catch (err) {
    logger.error('city-graphs list failed', err.message);
    return error(res, err.message);
  }
};

// Track in-flight background refreshes so we don't spawn two for the
// same slug if two requests hit within the refresh window.
const backgroundRefreshes = new Set();

// GET /api/city-graphs/:slug
// Returns { name, slug, bbox, center, node_count, edge_count, fetched_at,
//           kb, graph: { nodes, edges } }.
// If the row is missing we fetch synchronously; if it's older than
// AUTO_REFRESH_MS we return the stale copy immediately and kick off a
// background re-fetch (fire-and-forget). No blocking on stale reads.
export const getCity = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!CATALOG_BY_SLUG.has(slug)) {
      return error(res, `Unknown city: ${slug}`, 404);
    }
    let row = selectRow(slug);
    if (!row) {
      // First-ever request for this city — do the Overpass hit inline.
      // ~5-15 s worst case; caller sees a single slow request then it's
      // cached forever.
      await fetchAndStoreCity(slug);
      row = selectRow(slug);
      if (!row) return error(res, 'Failed to populate city graph', 500);
    } else {
      // Auto-refresh if the row is > 30 days old. Non-blocking — the
      // request that arrived while stale still gets the stale copy.
      const age = Date.now() - (row.updated_at || row.fetched_at);
      if (age > AUTO_REFRESH_MS && !backgroundRefreshes.has(slug)) {
        backgroundRefreshes.add(slug);
        fetchAndStoreCity(slug)
          .catch((e) => logger.warn(`city-graphs: bg refresh ${slug} failed: ${e.message}`))
          .finally(() => backgroundRefreshes.delete(slug));
      }
    }
    const json = (await gunzip(row.graph)).toString('utf8');
    const graph = JSON.parse(json);
    return success(res, {
      slug: row.slug,
      name: row.name,
      bbox: row.bbox,
      center: { lat: row.center_lat, lng: row.center_lng },
      node_count: row.node_count,
      edge_count: row.edge_count,
      fetched_at: row.fetched_at,
      kb: Math.round(row.bytes / 1024),
      stale: (Date.now() - (row.updated_at || row.fetched_at)) > AUTO_REFRESH_MS,
      graph,
    });
  } catch (err) {
    logger.error(`city-graphs get failed: ${err.message}`);
    return error(res, err.message);
  }
};

// GET /api/city-graphs/:slug/places?q=&limit=20
// Prefix-match search on lowercased place names for the given city.
// First request per city warms an in-memory Trie built from the DB rows,
// so subsequent hits are O(k) where k = prefix length.
export const searchPlaces = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!CATALOG_BY_SLUG.has(slug)) {
      return error(res, `Unknown city: ${slug}`, 404);
    }
    const q = String(req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    // Warm places table for this city if it's empty (lazy seed on first
    // search, so cities that only get graph traffic don't hit Overpass
    // twice pre-emptively).
    const { n } = countPlacesStmt.get(slug);
    if (n < MIN_PLACES) {
      try {
        await ensurePlacesForCity(slug);
      } catch (err) {
        logger.warn(`city-graphs: on-demand places seed failed for ${slug}: ${err.message}`);
      }
    }

    if (!q) {
      // No query — return the top-N by row insertion order (stable) so
      // the FE can still show "popular labels" on the map overlay.
      const rows = selectPlacesStmt.all(slug).slice(0, limit);
      return success(res, {
        items: rows.map((r) => ({ name: r.name, kind: r.kind, lat: r.lat, lng: r.lng })),
      });
    }

    // Fuzzy pipeline: exact → prefix (Trie) → substring → trigram.
    // Winner-per-row scoring, then top-N by score.
    const entry = getIndexFor(slug);
    const scored = scoreQueryAgainstIndex(entry, q);
    const ranked = [...scored.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit);
    const items = ranked.map(([idx, meta]) => {
      const p = entry.rows[idx];
      return {
        name: p.name,
        kind: p.kind,
        lat: p.lat,
        lng: p.lng,
        score: meta.score,
        matchType: meta.matchType,
      };
    });
    return success(res, { items });
  } catch (err) {
    logger.error(`city-graphs places search failed: ${err.message}`);
    return error(res, err.message);
  }
};

// GET /api/city-graphs/places?q=…&limit=20
// Cross-city fallback — searches every city's places table when the user
// hasn't picked a city yet. Same ranking as the per-city search, but the
// per-city top-N is unioned then re-ranked globally. `city_slug` is
// stitched onto every result so the FE can auto-switch cities on select.
//
// Rows-per-city are small (<a few hundred), and we only search cities
// that have already been seeded — no on-demand Overpass hits from this
// path. If a city's places table is empty it's silently skipped.
export const searchPlacesAll = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    if (!q) return success(res, { items: [] });

    const all = [];
    for (const spec of CITY_CATALOG) {
      const { n } = countPlacesStmt.get(spec.slug);
      if (n < 1) continue;
      const entry = getIndexFor(spec.slug);
      const scored = scoreQueryAgainstIndex(entry, q);
      // Take this city's top-N by score, then merge across all cities
      // and re-rank. Capping per-city keeps the merge budget bounded
      // when many cities happen to match a common substring.
      const cityTop = [...scored.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit);
      for (const [idx, meta] of cityTop) {
        const p = entry.rows[idx];
        all.push({
          name: p.name,
          kind: p.kind,
          lat: p.lat,
          lng: p.lng,
          city_slug: spec.slug,
          city_name: spec.name,
          score: meta.score,
          matchType: meta.matchType,
        });
      }
    }

    all.sort((a, b) => b.score - a.score);
    return success(res, { items: all.slice(0, limit) });
  } catch (err) {
    logger.error(`city-graphs cross-city places search failed: ${err.message}`);
    return error(res, err.message);
  }
};

// POST /api/city-graphs/:slug/refresh  (vault-gated at the route level)
// Forces a fresh Overpass hit. Returns the new metadata (no payload) so
// the caller can flag its client cache as invalidated and re-download
// via the plain GET.
export const refreshCity = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!CATALOG_BY_SLUG.has(slug)) {
      return error(res, `Unknown city: ${slug}`, 404);
    }
    const meta = await fetchAndStoreCity(slug);
    // Refresh places too on manual refresh — cheaper than making
    // two vault-gated calls.
    try { await ensurePlacesForCity(slug, { force: true }); } catch (_) {}
    return success(res, meta);
  } catch (err) {
    logger.error(`city-graphs refresh failed: ${err.message}`);
    return error(res, err.message);
  }
};
