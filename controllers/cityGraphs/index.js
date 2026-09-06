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
//                                          (fetches from Overpass if missing)
//   POST /api/city-graphs/:slug/refresh  — vault-gated, forces re-fetch
//
// Overpass rate-limit is polite:
//   • one hit per city per 24 h from the public GET path (soft — we serve
//     the stale row and kick off a background refetch)
//   • the refresh endpoint bypasses the 24 h check but requires vault

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
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const REFETCH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Build the QL query for a given bbox string 'south,west,north,east'.
// We ask for the standard highway hierarchy plus residential /
// living_street so smaller streets are drawable inside a metro core.
function buildOverpassQL(bbox) {
  return `[out:json][timeout:60];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](${bbox});
(._;>;);
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

// Hit Overpass. We POST the QL body form-urlencoded — same shape the FE
// used before we moved this call server-side. Node 18+ has native fetch.
async function fetchFromOverpass(bbox) {
  const body = new URLSearchParams({ data: buildOverpassQL(bbox) }).toString();
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass rejects unidentified UAs with 406. Give it a real name +
      // contact so the OSM ops team can reach us if we cause trouble.
      'User-Agent': 'sid-be city-graphs cache (+https://siddharthfulia.com)',
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Overpass HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  const json = await res.json();
  return parseOverpass(json);
}

// ── Storage helpers ────────────────────────────────────────────────
function selectMeta(slug) {
  return db.prepare(`
    SELECT slug, name, bbox, center_lat, center_lng, node_count, edge_count,
           fetched_at, bytes
      FROM city_graphs WHERE slug = ?
  `).get(slug);
}

function selectRow(slug) {
  return db.prepare(`
    SELECT slug, name, bbox, center_lat, center_lng, graph, node_count,
           edge_count, fetched_at, bytes
      FROM city_graphs WHERE slug = ?
  `).get(slug);
}

const upsertStmt = db.prepare(`
  INSERT INTO city_graphs (slug, name, bbox, center_lat, center_lng, graph,
                           node_count, edge_count, fetched_at, bytes)
  VALUES (@slug, @name, @bbox, @center_lat, @center_lng, @graph,
          @node_count, @edge_count, @fetched_at, @bytes)
  ON CONFLICT(slug) DO UPDATE SET
    name       = excluded.name,
    bbox       = excluded.bbox,
    center_lat = excluded.center_lat,
    center_lng = excluded.center_lng,
    graph      = excluded.graph,
    node_count = excluded.node_count,
    edge_count = excluded.edge_count,
    fetched_at = excluded.fetched_at,
    bytes      = excluded.bytes
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
  upsertStmt.run({
    slug,
    name: spec.name,
    bbox: spec.bbox,
    center_lat: spec.center.lat,
    center_lng: spec.center.lng,
    graph: blob,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    fetched_at: Date.now(),
    bytes: blob.length,
  });
  logger.info(
    `city-graphs: stored ${slug} — nodes=${graph.nodes.length} edges=${graph.edges.length} ` +
    `gz=${(blob.length / 1024).toFixed(1)} KB in ${Date.now() - t0} ms`,
  );
  return selectMeta(slug);
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

// GET /api/city-graphs/:slug
// Returns { name, slug, bbox, center, node_count, edge_count, fetched_at,
//           kb, graph: { nodes, edges } }.
// If the row is missing we fetch synchronously; if it's older than 24 h we
// still return the stale copy immediately (no on-request Overpass hit —
// the vault-gated refresh endpoint exists for that).
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
      stale: (Date.now() - row.fetched_at) > REFETCH_COOLDOWN_MS,
      graph,
    });
  } catch (err) {
    logger.error(`city-graphs get failed: ${err.message}`);
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
    return success(res, meta);
  } catch (err) {
    logger.error(`city-graphs refresh failed: ${err.message}`);
    return error(res, err.message);
  }
};
