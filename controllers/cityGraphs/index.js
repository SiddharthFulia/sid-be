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
//   GET  /api/city-graphs/:slug/places   — public, prefix search for area
//                                          names (Trie-backed, lazy per city)
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

// Slug -> Trie. Built lazily on first search per city; invalidated when
// places for that city are re-seeded.
const trieCache = new Map();

function getTrieFor(slug) {
  if (trieCache.has(slug)) return trieCache.get(slug);
  const rows = selectPlacesStmt.all(slug);
  const trie = new Trie();
  trie.places = rows;
  for (let i = 0; i < rows.length; i++) trie.insert(rows[i], i);
  trieCache.set(slug, trie);
  return trie;
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

    const trie = getTrieFor(slug);
    const idxs = trie.search(q, limit);
    const items = idxs.map((i) => {
      const p = trie.places[i];
      return { name: p.name, kind: p.kind, lat: p.lat, lng: p.lng };
    });
    return success(res, { items });
  } catch (err) {
    logger.error(`city-graphs places search failed: ${err.message}`);
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
