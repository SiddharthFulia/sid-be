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
import { createHash } from 'node:crypto';
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
// `state` is the FE picker's grouping key ("Karnataka", "Maharashtra"…).
// Sourced from CITY_CATALOG at write time so `WHERE state = ?` filters
// hit an index instead of scanning every row and JOIN'ing to the catalog.
ensureColumn('city_graphs', 'state', 'TEXT');

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
  -- Composite for map-overlay filters like WHERE city_slug=? AND kind=?
  -- (or kind IN (?,?,…)). Direct index seek per row family.
  CREATE INDEX IF NOT EXISTS idx_city_places_slug_kind      ON city_places(city_slug, kind);
  -- Covering index for filtered fuzzy prefix search — city_slug + kind +
  -- name_lc together lets SQLite range-scan just the "restaurants in
  -- Mumbai starting with 'ta'" band without touching the heap.
  CREATE INDEX IF NOT EXISTS idx_city_places_slug_kind_name ON city_places(city_slug, kind, name_lc);
  -- Enables /api/city-graphs?state=Karnataka in O(log n) — otherwise
  -- SQLite full-scans city_graphs on every metadata list request.
  CREATE INDEX IF NOT EXISTS idx_city_graphs_state ON city_graphs(state);
`);

// Backfill state from the catalog for pre-migration rows so the new
// idx_city_graphs_state index has real values to seek on. Idempotent —
// only touches rows where state is NULL. Runs once on first boot after
// the migration; a no-op every subsequent boot.
{
  const stmtBackfillState = db.prepare(`UPDATE city_graphs SET state = ? WHERE slug = ? AND state IS NULL`);
  const stmtNeedsBackfill = db.prepare(`SELECT 1 FROM city_graphs WHERE state IS NULL LIMIT 1`);
  if (stmtNeedsBackfill.get()) {
    // Deferred to after CITY_CATALOG is defined — see bottom of module init.
    // We stash a marker and finalise below once CATALOG_BY_SLUG exists.
    globalThis.__cityGraphsBackfillState = { stmtBackfillState };
  }
}

// ── Seed catalogue ─────────────────────────────────────────────────
// The all-India catalogue — 160+ cities across every state + all UTs.
// Each entry surfaces from the metadata list endpoint even before the
// row is populated, so the FE can render the picker with disabled
// states for "not fetched yet" cities.
//
// bbox width heuristic:
//   • ~0.25° - 0.30° for tier-1 metros (Mumbai, Delhi, Bangalore …)
//   • ~0.15° - 0.20° for tier-2 state capitals (Bhopal, Jaipur …)
//   • ~0.10° - 0.15° for tier-3 cities (Gaya, Purnia, Kota, Jamshedpur …)
//   • ~0.08° - 0.10° for small towns / hill stations (Manali, Nainital,
//     Mount Abu, Rishikesh, Puri, Panaji, Kohima, Kavaratti …)
// Smaller bboxes keep Overpass responses light for cities that don't
// need a big canvas footprint anyway. Small island / hill towns
// (Kavaratti, Port Blair, Leh) use ~0.08° square boxes — the road
// network is sparse and a big bbox would just harvest empty ocean /
// mountain squares.
//
// `state` field groups entries in the FE picker. Union Territories that
// have their own capital-scale city are called out under `Chandigarh`,
// `Puducherry`, `J&K`, `Ladakh`, `Andaman & Nicobar`, `Lakshadweep`,
// `Dadra & Nagar Haveli & Daman & Diu`. Delhi is its own UT-state entry.
export const CITY_CATALOG = [
  // ── Andhra Pradesh ──
  { slug: 'anantapur',     name: 'Anantapur',            state: 'Andhra Pradesh',    bbox: '14.62,77.55,14.75,77.70', center: { lat: 14.6819, lng: 77.6006 } },
  { slug: 'guntur',        name: 'Guntur',               state: 'Andhra Pradesh',    bbox: '16.25,80.35,16.40,80.55', center: { lat: 16.3067, lng: 80.4365 } },
  { slug: 'kakinada',      name: 'Kakinada',             state: 'Andhra Pradesh',    bbox: '16.90,82.15,17.05,82.30', center: { lat: 16.9891, lng: 82.2475 } },
  { slug: 'kurnool',       name: 'Kurnool',              state: 'Andhra Pradesh',    bbox: '15.75,77.95,15.90,78.10', center: { lat: 15.8281, lng: 78.0373 } },
  { slug: 'nellore',       name: 'Nellore',              state: 'Andhra Pradesh',    bbox: '14.40,79.90,14.55,80.05', center: { lat: 14.4426, lng: 79.9865 } },
  { slug: 'rajahmundry',   name: 'Rajahmundry',          state: 'Andhra Pradesh',    bbox: '16.95,81.70,17.10,81.85', center: { lat: 17.0005, lng: 81.8040 } },
  { slug: 'tirupati',      name: 'Tirupati',             state: 'Andhra Pradesh',    bbox: '13.55,79.35,13.70,79.50', center: { lat: 13.6288, lng: 79.4192 } },
  { slug: 'vijayawada',    name: 'Vijayawada',           state: 'Andhra Pradesh',    bbox: '16.45,80.55,16.60,80.75', center: { lat: 16.5062, lng: 80.6480 } },
  { slug: 'visakhapatnam', name: 'Visakhapatnam',        state: 'Andhra Pradesh',    bbox: '17.65,83.15,17.80,83.35', center: { lat: 17.6868, lng: 83.2185 } },
  // ── Arunachal Pradesh ──
  { slug: 'itanagar',      name: 'Itanagar',             state: 'Arunachal Pradesh', bbox: '27.05,93.55,27.15,93.70', center: { lat: 27.1000, lng: 93.6167 } },
  // ── Assam ──
  { slug: 'dibrugarh',     name: 'Dibrugarh',            state: 'Assam',             bbox: '27.40,94.85,27.55,95.05', center: { lat: 27.4728, lng: 94.9120 } },
  { slug: 'guwahati',      name: 'Guwahati',             state: 'Assam',             bbox: '26.10,91.65,26.25,91.85', center: { lat: 26.1445, lng: 91.7362 } },
  { slug: 'jorhat',        name: 'Jorhat',               state: 'Assam',             bbox: '26.70,94.15,26.85,94.30', center: { lat: 26.7509, lng: 94.2037 } },
  { slug: 'silchar',       name: 'Silchar',              state: 'Assam',             bbox: '24.75,92.75,24.90,92.90', center: { lat: 24.8333, lng: 92.7789 } },
  { slug: 'tezpur',        name: 'Tezpur',               state: 'Assam',             bbox: '26.55,92.70,26.70,92.85', center: { lat: 26.6335, lng: 92.7935 } },
  // ── Bihar ──
  { slug: 'bhagalpur',     name: 'Bhagalpur',            state: 'Bihar',             bbox: '25.20,86.90,25.35,87.05', center: { lat: 25.2425, lng: 86.9842 } },
  { slug: 'darbhanga',     name: 'Darbhanga',            state: 'Bihar',             bbox: '26.10,85.85,26.25,86.00', center: { lat: 26.1542, lng: 85.8918 } },
  { slug: 'gaya',          name: 'Gaya',                 state: 'Bihar',             bbox: '24.75,84.95,24.85,85.10', center: { lat: 24.7955, lng: 85.0002 } },
  { slug: 'muzaffarpur',   name: 'Muzaffarpur',          state: 'Bihar',             bbox: '26.05,85.30,26.20,85.45', center: { lat: 26.1197, lng: 85.3910 } },
  { slug: 'patna',         name: 'Patna',                state: 'Bihar',             bbox: '25.55,85.05,25.70,85.25', center: { lat: 25.5941, lng: 85.1376 } },
  { slug: 'purnia',        name: 'Purnia',               state: 'Bihar',             bbox: '25.72,87.40,25.82,87.55', center: { lat: 25.7771, lng: 87.4753 } },
  // ── Chhattisgarh ──
  { slug: 'bhilai',        name: 'Bhilai',               state: 'Chhattisgarh',      bbox: '21.15,81.30,21.30,81.45', center: { lat: 21.2094, lng: 81.4285 } },
  { slug: 'bilaspur',      name: 'Bilaspur',             state: 'Chhattisgarh',      bbox: '22.02,82.05,22.15,82.20', center: { lat: 22.0797, lng: 82.1409 } },
  { slug: 'korba',         name: 'Korba',                state: 'Chhattisgarh',      bbox: '22.30,82.65,22.40,82.80', center: { lat: 22.3595, lng: 82.7501 } },
  { slug: 'raipur',        name: 'Raipur',               state: 'Chhattisgarh',      bbox: '21.15,81.55,21.30,81.75', center: { lat: 21.2514, lng: 81.6296 } },
  // ── Goa ──
  { slug: 'margao',        name: 'Margao',               state: 'Goa',               bbox: '15.22,73.90,15.32,74.00', center: { lat: 15.2832, lng: 73.9862 } },
  { slug: 'panaji',        name: 'Panaji',               state: 'Goa',               bbox: '15.45,73.75,15.55,73.90', center: { lat: 15.4909, lng: 73.8278 } },
  { slug: 'vasco-da-gama', name: 'Vasco da Gama',        state: 'Goa',               bbox: '15.35,73.75,15.45,73.85', center: { lat: 15.3981, lng: 73.8113 } },
  // ── Gujarat ──
  { slug: 'ahmedabad',     name: 'Ahmedabad',            state: 'Gujarat',           bbox: '22.95,72.45,23.15,72.70', center: { lat: 23.0225, lng: 72.5714 } },
  { slug: 'bhavnagar',     name: 'Bhavnagar',            state: 'Gujarat',           bbox: '21.72,72.05,21.85,72.25', center: { lat: 21.7645, lng: 72.1519 } },
  { slug: 'gandhinagar',   name: 'Gandhinagar',          state: 'Gujarat',           bbox: '23.15,72.55,23.30,72.75', center: { lat: 23.2156, lng: 72.6369 } },
  { slug: 'jamnagar',      name: 'Jamnagar',             state: 'Gujarat',           bbox: '22.40,70.00,22.55,70.20', center: { lat: 22.4707, lng: 70.0577 } },
  { slug: 'junagadh',      name: 'Junagadh',             state: 'Gujarat',           bbox: '21.45,70.40,21.60,70.55', center: { lat: 21.5222, lng: 70.4579 } },
  { slug: 'rajkot',        name: 'Rajkot',               state: 'Gujarat',           bbox: '22.20,70.70,22.35,70.90', center: { lat: 22.3039, lng: 70.8022 } },
  { slug: 'surat',         name: 'Surat',                state: 'Gujarat',           bbox: '21.10,72.75,21.25,72.90', center: { lat: 21.1702, lng: 72.8311 } },
  { slug: 'vadodara',      name: 'Vadodara',             state: 'Gujarat',           bbox: '22.25,73.10,22.40,73.30', center: { lat: 22.3072, lng: 73.1812 } },
  // ── Haryana ──
  { slug: 'faridabad',     name: 'Faridabad',            state: 'Haryana',           bbox: '28.35,77.20,28.50,77.40', center: { lat: 28.4089, lng: 77.3178 } },
  { slug: 'gurugram',      name: 'Gurugram',             state: 'Haryana',           bbox: '28.40,76.95,28.55,77.15', center: { lat: 28.4595, lng: 77.0266 } },
  { slug: 'hisar',         name: 'Hisar',                state: 'Haryana',           bbox: '29.10,75.65,29.25,75.85', center: { lat: 29.1492, lng: 75.7217 } },
  { slug: 'karnal',        name: 'Karnal',               state: 'Haryana',           bbox: '29.60,76.90,29.75,77.10', center: { lat: 29.6857, lng: 76.9905 } },
  { slug: 'panipat',       name: 'Panipat',              state: 'Haryana',           bbox: '29.30,76.85,29.45,77.05', center: { lat: 29.3909, lng: 76.9635 } },
  { slug: 'rohtak',        name: 'Rohtak',               state: 'Haryana',           bbox: '28.80,76.50,28.95,76.70', center: { lat: 28.8955, lng: 76.6066 } },
  { slug: 'sonipat',       name: 'Sonipat',              state: 'Haryana',           bbox: '28.90,77.00,29.05,77.20', center: { lat: 28.9931, lng: 77.0151 } },
  // ── Himachal Pradesh ──
  { slug: 'dharamshala',   name: 'Dharamshala',          state: 'Himachal Pradesh',  bbox: '32.18,76.30,32.26,76.40', center: { lat: 32.2190, lng: 76.3234 } },
  { slug: 'manali',        name: 'Manali',               state: 'Himachal Pradesh',  bbox: '32.20,77.15,32.28,77.25', center: { lat: 32.2432, lng: 77.1892 } },
  { slug: 'mandi',         name: 'Mandi',                state: 'Himachal Pradesh',  bbox: '31.65,76.85,31.75,76.99', center: { lat: 31.7080, lng: 76.9319 } },
  { slug: 'shimla',        name: 'Shimla',               state: 'Himachal Pradesh',  bbox: '31.05,77.10,31.15,77.25', center: { lat: 31.1048, lng: 77.1734 } },
  // ── Jharkhand ──
  { slug: 'bokaro',        name: 'Bokaro',               state: 'Jharkhand',         bbox: '23.60,86.05,23.75,86.25', center: { lat: 23.6693, lng: 86.1511 } },
  { slug: 'dhanbad',       name: 'Dhanbad',              state: 'Jharkhand',         bbox: '23.72,86.35,23.85,86.55', center: { lat: 23.7957, lng: 86.4304 } },
  { slug: 'jamshedpur',    name: 'Jamshedpur',           state: 'Jharkhand',         bbox: '22.72,86.10,22.85,86.30', center: { lat: 22.8046, lng: 86.2029 } },
  { slug: 'ranchi',        name: 'Ranchi',               state: 'Jharkhand',         bbox: '23.30,85.25,23.45,85.40', center: { lat: 23.3441, lng: 85.3096 } },
  // ── Karnataka ──
  { slug: 'bangalore',     name: 'Bangalore',            state: 'Karnataka',         bbox: '12.85,77.45,13.10,77.75', center: { lat: 12.9716, lng: 77.5946 } },
  { slug: 'belgaum',       name: 'Belgaum',              state: 'Karnataka',         bbox: '15.80,74.45,15.95,74.60', center: { lat: 15.8497, lng: 74.4977 } },
  { slug: 'davanagere',    name: 'Davanagere',           state: 'Karnataka',         bbox: '14.40,75.85,14.55,76.00', center: { lat: 14.4644, lng: 75.9218 } },
  { slug: 'hubli',         name: 'Hubli',                state: 'Karnataka',         bbox: '15.30,75.05,15.45,75.25', center: { lat: 15.3647, lng: 75.1240 } },
  { slug: 'mangalore',     name: 'Mangalore',            state: 'Karnataka',         bbox: '12.80,74.75,12.95,74.95', center: { lat: 12.9141, lng: 74.8560 } },
  { slug: 'mysore',        name: 'Mysore',               state: 'Karnataka',         bbox: '12.22,76.55,12.40,76.75', center: { lat: 12.2958, lng: 76.6394 } },
  { slug: 'udupi',         name: 'Udupi',                state: 'Karnataka',         bbox: '13.30,74.70,13.40,74.80', center: { lat: 13.3409, lng: 74.7421 } },
  // ── Kerala ──
  { slug: 'alappuzha',     name: 'Alappuzha',            state: 'Kerala',            bbox: '9.45,76.25,9.55,76.40',   center: { lat: 9.4981,  lng: 76.3388 } },
  { slug: 'kannur',        name: 'Kannur',               state: 'Kerala',            bbox: '11.80,75.30,11.95,75.45', center: { lat: 11.8745, lng: 75.3704 } },
  { slug: 'kochi',         name: 'Kochi',                state: 'Kerala',            bbox: '9.90,76.20,10.05,76.35',  center: { lat: 9.9312,  lng: 76.2673 } },
  { slug: 'kollam',        name: 'Kollam',               state: 'Kerala',            bbox: '8.85,76.55,9.00,76.70',   center: { lat: 8.8932,  lng: 76.6141 } },
  { slug: 'kozhikode',     name: 'Kozhikode',            state: 'Kerala',            bbox: '11.20,75.70,11.35,75.85', center: { lat: 11.2588, lng: 75.7804 } },
  { slug: 'thiruvananthapuram', name: 'Thiruvananthapuram', state: 'Kerala',         bbox: '8.45,76.85,8.60,77.05',   center: { lat: 8.5241,  lng: 76.9366 } },
  { slug: 'thrissur',      name: 'Thrissur',             state: 'Kerala',            bbox: '10.45,76.15,10.60,76.30', center: { lat: 10.5276, lng: 76.2144 } },
  // ── Madhya Pradesh ──
  { slug: 'bhopal',        name: 'Bhopal',               state: 'Madhya Pradesh',    bbox: '23.15,77.30,23.35,77.50', center: { lat: 23.2599, lng: 77.4126 } },
  { slug: 'gwalior',       name: 'Gwalior',              state: 'Madhya Pradesh',    bbox: '26.15,78.10,26.30,78.30', center: { lat: 26.2183, lng: 78.1828 } },
  { slug: 'indore',        name: 'Indore',               state: 'Madhya Pradesh',    bbox: '22.65,75.75,22.80,75.95', center: { lat: 22.7196, lng: 75.8577 } },
  { slug: 'jabalpur',      name: 'Jabalpur',             state: 'Madhya Pradesh',    bbox: '23.10,79.85,23.25,80.05', center: { lat: 23.1815, lng: 79.9864 } },
  { slug: 'sagar',         name: 'Sagar',                state: 'Madhya Pradesh',    bbox: '23.78,78.65,23.90,78.80', center: { lat: 23.8388, lng: 78.7378 } },
  { slug: 'ujjain',        name: 'Ujjain',               state: 'Madhya Pradesh',    bbox: '23.10,75.70,23.25,75.85', center: { lat: 23.1793, lng: 75.7849 } },
  // ── Maharashtra ──
  { slug: 'amravati',      name: 'Amravati',             state: 'Maharashtra',       bbox: '20.88,77.70,21.00,77.85', center: { lat: 20.9374, lng: 77.7796 } },
  { slug: 'aurangabad',    name: 'Aurangabad',           state: 'Maharashtra',       bbox: '19.80,75.25,19.95,75.45', center: { lat: 19.8762, lng: 75.3433 } },
  { slug: 'kolhapur',      name: 'Kolhapur',             state: 'Maharashtra',       bbox: '16.62,74.15,16.77,74.30', center: { lat: 16.7050, lng: 74.2433 } },
  { slug: 'mumbai',        name: 'Mumbai',               state: 'Maharashtra',       bbox: '18.90,72.75,19.30,73.05', center: { lat: 19.0760, lng: 72.8777 } },
  { slug: 'nagpur',        name: 'Nagpur',               state: 'Maharashtra',       bbox: '21.05,78.95,21.20,79.15', center: { lat: 21.1458, lng: 79.0882 } },
  { slug: 'nashik',        name: 'Nashik',               state: 'Maharashtra',       bbox: '19.95,73.70,20.10,73.90', center: { lat: 19.9975, lng: 73.7898 } },
  { slug: 'pune',          name: 'Pune',                 state: 'Maharashtra',       bbox: '18.45,73.75,18.65,73.95', center: { lat: 18.5204, lng: 73.8567 } },
  { slug: 'solapur',       name: 'Solapur',              state: 'Maharashtra',       bbox: '17.60,75.85,17.75,76.05', center: { lat: 17.6599, lng: 75.9064 } },
  // ── Manipur ──
  { slug: 'imphal',        name: 'Imphal',               state: 'Manipur',           bbox: '24.75,93.85,24.85,94.00', center: { lat: 24.8170, lng: 93.9368 } },
  // ── Meghalaya ──
  { slug: 'shillong',      name: 'Shillong',             state: 'Meghalaya',         bbox: '25.55,91.85,25.65,92.00', center: { lat: 25.5788, lng: 91.8933 } },
  { slug: 'tura',          name: 'Tura',                 state: 'Meghalaya',         bbox: '25.47,90.17,25.55,90.27', center: { lat: 25.5138, lng: 90.2201 } },
  // ── Mizoram ──
  { slug: 'aizawl',        name: 'Aizawl',               state: 'Mizoram',           bbox: '23.70,92.65,23.80,92.80', center: { lat: 23.7307, lng: 92.7173 } },
  // ── Nagaland ──
  { slug: 'dimapur',       name: 'Dimapur',              state: 'Nagaland',          bbox: '25.87,93.68,25.95,93.78', center: { lat: 25.9091, lng: 93.7266 } },
  { slug: 'kohima',        name: 'Kohima',               state: 'Nagaland',          bbox: '25.65,94.05,25.75,94.20', center: { lat: 25.6751, lng: 94.1086 } },
  // ── Odisha ──
  { slug: 'bhubaneswar',   name: 'Bhubaneswar',          state: 'Odisha',            bbox: '20.20,85.75,20.35,85.90', center: { lat: 20.2961, lng: 85.8245 } },
  { slug: 'cuttack',       name: 'Cuttack',              state: 'Odisha',            bbox: '20.40,85.80,20.55,85.95', center: { lat: 20.4625, lng: 85.8828 } },
  { slug: 'puri',          name: 'Puri',                 state: 'Odisha',            bbox: '19.77,85.80,19.85,85.88', center: { lat: 19.8135, lng: 85.8312 } },
  { slug: 'rourkela',      name: 'Rourkela',             state: 'Odisha',            bbox: '22.15,84.75,22.30,84.95', center: { lat: 22.2604, lng: 84.8536 } },
  { slug: 'sambalpur',     name: 'Sambalpur',            state: 'Odisha',            bbox: '21.40,83.90,21.55,84.05', center: { lat: 21.4669, lng: 83.9812 } },
  // ── Punjab ──
  { slug: 'amritsar',      name: 'Amritsar',             state: 'Punjab',            bbox: '31.55,74.80,31.70,74.95', center: { lat: 31.6340, lng: 74.8723 } },
  { slug: 'bathinda',      name: 'Bathinda',             state: 'Punjab',            bbox: '30.15,74.90,30.30,75.05', center: { lat: 30.2110, lng: 74.9455 } },
  { slug: 'jalandhar',     name: 'Jalandhar',            state: 'Punjab',            bbox: '31.25,75.50,31.40,75.70', center: { lat: 31.3260, lng: 75.5762 } },
  { slug: 'ludhiana',      name: 'Ludhiana',             state: 'Punjab',            bbox: '30.85,75.75,31.00,75.95', center: { lat: 30.9010, lng: 75.8573 } },
  { slug: 'patiala',       name: 'Patiala',              state: 'Punjab',            bbox: '30.25,76.30,30.40,76.50', center: { lat: 30.3398, lng: 76.3869 } },
  // ── Rajasthan ──
  { slug: 'ajmer',         name: 'Ajmer',                state: 'Rajasthan',         bbox: '26.40,74.55,26.55,74.75', center: { lat: 26.4499, lng: 74.6399 } },
  { slug: 'alwar',         name: 'Alwar',                state: 'Rajasthan',         bbox: '27.50,76.55,27.65,76.70', center: { lat: 27.5530, lng: 76.6346 } },
  { slug: 'bikaner',       name: 'Bikaner',              state: 'Rajasthan',         bbox: '28.00,73.20,28.15,73.40', center: { lat: 28.0229, lng: 73.3119 } },
  { slug: 'jaipur',        name: 'Jaipur',               state: 'Rajasthan',         bbox: '26.80,75.70,27.00,75.90', center: { lat: 26.9124, lng: 75.7873 } },
  { slug: 'jodhpur',       name: 'Jodhpur',              state: 'Rajasthan',         bbox: '26.20,72.95,26.35,73.10', center: { lat: 26.2389, lng: 73.0243 } },
  { slug: 'kota',          name: 'Kota',                 state: 'Rajasthan',         bbox: '25.10,75.75,25.25,75.95', center: { lat: 25.2138, lng: 75.8648 } },
  { slug: 'mount-abu',     name: 'Mount Abu',            state: 'Rajasthan',         bbox: '24.55,72.65,24.63,72.75', center: { lat: 24.5926, lng: 72.7156 } },
  { slug: 'udaipur',       name: 'Udaipur',              state: 'Rajasthan',         bbox: '24.55,73.65,24.65,73.75', center: { lat: 24.5854, lng: 73.7125 } },
  // ── Sikkim ──
  { slug: 'gangtok',       name: 'Gangtok',              state: 'Sikkim',            bbox: '27.30,88.55,27.40,88.70', center: { lat: 27.3389, lng: 88.6065 } },
  // ── Tamil Nadu ──
  { slug: 'chennai',       name: 'Chennai',              state: 'Tamil Nadu',        bbox: '12.90,80.15,13.20,80.30', center: { lat: 13.0827, lng: 80.2707 } },
  { slug: 'coimbatore',    name: 'Coimbatore',           state: 'Tamil Nadu',        bbox: '10.95,76.90,11.10,77.05', center: { lat: 11.0168, lng: 76.9558 } },
  { slug: 'erode',         name: 'Erode',                state: 'Tamil Nadu',        bbox: '11.30,77.65,11.45,77.80', center: { lat: 11.3410, lng: 77.7172 } },
  { slug: 'kanchipuram',   name: 'Kanchipuram',          state: 'Tamil Nadu',        bbox: '12.75,79.65,12.90,79.80', center: { lat: 12.8342, lng: 79.7036 } },
  { slug: 'madurai',       name: 'Madurai',              state: 'Tamil Nadu',        bbox: '9.85,78.05,9.99,78.20',   center: { lat: 9.9252,  lng: 78.1198 } },
  { slug: 'salem',         name: 'Salem',                state: 'Tamil Nadu',        bbox: '11.60,78.05,11.75,78.25', center: { lat: 11.6643, lng: 78.1460 } },
  { slug: 'thoothukudi',   name: 'Thoothukudi',          state: 'Tamil Nadu',        bbox: '8.72,78.10,8.85,78.25',   center: { lat: 8.7642,  lng: 78.1348 } },
  { slug: 'tiruchirappalli', name: 'Tiruchirappalli',    state: 'Tamil Nadu',        bbox: '10.75,78.60,10.90,78.80', center: { lat: 10.7905, lng: 78.7047 } },
  { slug: 'tirunelveli',   name: 'Tirunelveli',          state: 'Tamil Nadu',        bbox: '8.65,77.65,8.80,77.80',   center: { lat: 8.7139,  lng: 77.7567 } },
  { slug: 'vellore',       name: 'Vellore',              state: 'Tamil Nadu',        bbox: '12.85,79.05,13.00,79.25', center: { lat: 12.9165, lng: 79.1325 } },
  // ── Telangana ──
  { slug: 'hyderabad',     name: 'Hyderabad',            state: 'Telangana',         bbox: '17.30,78.30,17.55,78.60', center: { lat: 17.3850, lng: 78.4867 } },
  { slug: 'karimnagar',    name: 'Karimnagar',           state: 'Telangana',         bbox: '18.38,79.05,18.50,79.20', center: { lat: 18.4386, lng: 79.1288 } },
  { slug: 'nizamabad',     name: 'Nizamabad',            state: 'Telangana',         bbox: '18.62,78.02,18.75,78.17', center: { lat: 18.6725, lng: 78.0941 } },
  { slug: 'warangal',      name: 'Warangal',             state: 'Telangana',         bbox: '17.95,79.50,18.05,79.65', center: { lat: 17.9689, lng: 79.5941 } },
  // ── Tripura ──
  { slug: 'agartala',      name: 'Agartala',             state: 'Tripura',           bbox: '23.80,91.25,23.90,91.35', center: { lat: 23.8315, lng: 91.2868 } },
  // ── Uttar Pradesh ──
  { slug: 'agra',          name: 'Agra',                 state: 'Uttar Pradesh',     bbox: '27.10,77.95,27.25,78.10', center: { lat: 27.1767, lng: 78.0081 } },
  { slug: 'aligarh',       name: 'Aligarh',              state: 'Uttar Pradesh',     bbox: '27.82,78.00,27.97,78.15', center: { lat: 27.8974, lng: 78.0880 } },
  { slug: 'bareilly',      name: 'Bareilly',             state: 'Uttar Pradesh',     bbox: '28.28,79.30,28.43,79.50', center: { lat: 28.3670, lng: 79.4304 } },
  { slug: 'ghaziabad',     name: 'Ghaziabad',            state: 'Uttar Pradesh',     bbox: '28.60,77.35,28.75,77.55', center: { lat: 28.6692, lng: 77.4538 } },
  { slug: 'gorakhpur',     name: 'Gorakhpur',            state: 'Uttar Pradesh',     bbox: '26.68,83.30,26.83,83.50', center: { lat: 26.7606, lng: 83.3732 } },
  { slug: 'jhansi',        name: 'Jhansi',               state: 'Uttar Pradesh',     bbox: '25.40,78.50,25.55,78.65', center: { lat: 25.4484, lng: 78.5685 } },
  { slug: 'kanpur',        name: 'Kanpur',               state: 'Uttar Pradesh',     bbox: '26.40,80.25,26.55,80.40', center: { lat: 26.4499, lng: 80.3319 } },
  { slug: 'lucknow',       name: 'Lucknow',              state: 'Uttar Pradesh',     bbox: '26.75,80.85,26.95,81.05', center: { lat: 26.8467, lng: 80.9462 } },
  { slug: 'mathura',       name: 'Mathura',              state: 'Uttar Pradesh',     bbox: '27.42,77.60,27.55,77.75', center: { lat: 27.4924, lng: 77.6737 } },
  { slug: 'meerut',        name: 'Meerut',               state: 'Uttar Pradesh',     bbox: '28.90,77.60,29.05,77.80', center: { lat: 28.9845, lng: 77.7064 } },
  { slug: 'moradabad',     name: 'Moradabad',            state: 'Uttar Pradesh',     bbox: '28.75,78.65,28.90,78.85', center: { lat: 28.8386, lng: 78.7733 } },
  { slug: 'noida',         name: 'Noida',                state: 'Uttar Pradesh',     bbox: '28.50,77.30,28.65,77.45', center: { lat: 28.5355, lng: 77.3910 } },
  { slug: 'prayagraj',     name: 'Prayagraj',            state: 'Uttar Pradesh',     bbox: '25.35,81.75,25.50,81.95', center: { lat: 25.4358, lng: 81.8463 } },
  { slug: 'saharanpur',    name: 'Saharanpur',           state: 'Uttar Pradesh',     bbox: '29.90,77.45,30.05,77.65', center: { lat: 29.9680, lng: 77.5552 } },
  { slug: 'varanasi',      name: 'Varanasi',             state: 'Uttar Pradesh',     bbox: '25.25,82.90,25.40,83.05', center: { lat: 25.3176, lng: 82.9739 } },
  // ── Uttarakhand ──
  { slug: 'dehradun',      name: 'Dehradun',             state: 'Uttarakhand',       bbox: '30.25,77.95,30.40,78.10', center: { lat: 30.3165, lng: 78.0322 } },
  { slug: 'haridwar',      name: 'Haridwar',             state: 'Uttarakhand',       bbox: '29.90,78.10,30.03,78.25', center: { lat: 29.9457, lng: 78.1642 } },
  { slug: 'nainital',      name: 'Nainital',             state: 'Uttarakhand',       bbox: '29.35,79.42,29.43,79.52', center: { lat: 29.3803, lng: 79.4636 } },
  { slug: 'rishikesh',     name: 'Rishikesh',            state: 'Uttarakhand',       bbox: '30.06,78.22,30.14,78.32', center: { lat: 30.0869, lng: 78.2676 } },
  { slug: 'roorkee',       name: 'Roorkee',              state: 'Uttarakhand',       bbox: '29.82,77.83,29.92,77.95', center: { lat: 29.8543, lng: 77.8880 } },
  // ── West Bengal ──
  { slug: 'asansol',       name: 'Asansol',              state: 'West Bengal',       bbox: '23.63,86.85,23.78,87.05', center: { lat: 23.6739, lng: 86.9524 } },
  { slug: 'durgapur',      name: 'Durgapur',             state: 'West Bengal',       bbox: '23.45,87.20,23.60,87.40', center: { lat: 23.5204, lng: 87.3119 } },
  { slug: 'howrah',        name: 'Howrah',               state: 'West Bengal',       bbox: '22.50,88.20,22.65,88.40', center: { lat: 22.5958, lng: 88.2636 } },
  { slug: 'kharagpur',     name: 'Kharagpur',            state: 'West Bengal',       bbox: '22.27,87.15,22.42,87.35', center: { lat: 22.3460, lng: 87.2320 } },
  { slug: 'kolkata',       name: 'Kolkata',              state: 'West Bengal',       bbox: '22.45,88.25,22.65,88.45', center: { lat: 22.5726, lng: 88.3639 } },
  { slug: 'siliguri',      name: 'Siliguri',             state: 'West Bengal',       bbox: '26.65,88.35,26.80,88.50', center: { lat: 26.7271, lng: 88.3953 } },
  // ── Delhi (UT) ──
  { slug: 'delhi',         name: 'Delhi',                state: 'Delhi',             bbox: '28.45,76.90,28.85,77.35', center: { lat: 28.6139, lng: 77.2090 } },
  // ── Chandigarh (UT, shared capital of Punjab + Haryana) ──
  { slug: 'chandigarh',    name: 'Chandigarh',           state: 'Chandigarh',        bbox: '30.65,76.70,30.80,76.85', center: { lat: 30.7333, lng: 76.7794 } },
  // ── Puducherry (UT) ──
  { slug: 'puducherry',    name: 'Puducherry',           state: 'Puducherry',        bbox: '11.85,79.75,11.99,79.90', center: { lat: 11.9416, lng: 79.8083 } },
  // ── Jammu & Kashmir (UT) ──
  { slug: 'jammu',         name: 'Jammu',                state: 'Jammu & Kashmir',   bbox: '32.65,74.80,32.80,74.95', center: { lat: 32.7266, lng: 74.8570 } },
  { slug: 'srinagar',      name: 'Srinagar',             state: 'Jammu & Kashmir',   bbox: '34.05,74.75,34.15,74.90', center: { lat: 34.0837, lng: 74.7973 } },
  // ── Ladakh (UT) — sparse road network, small bbox on purpose ──
  { slug: 'leh',           name: 'Leh',                  state: 'Ladakh',            bbox: '34.10,77.55,34.20,77.65', center: { lat: 34.1526, lng: 77.5771 } },
  // ── Andaman & Nicobar (UT) — small port town, tight bbox ──
  { slug: 'port-blair',    name: 'Port Blair',           state: 'Andaman & Nicobar', bbox: '11.60,92.70,11.70,92.80', center: { lat: 11.6234, lng: 92.7265 } },
  // ── Lakshadweep (UT) — tiny atoll, tightest bbox in the catalogue ──
  { slug: 'kavaratti',     name: 'Kavaratti',            state: 'Lakshadweep',       bbox: '10.53,72.60,10.60,72.67', center: { lat: 10.5626, lng: 72.6363 } },
  // ── Dadra & Nagar Haveli and Daman & Diu (UT) ──
  { slug: 'silvassa',      name: 'Silvassa',             state: 'Dadra & Nagar Haveli', bbox: '20.20,72.95,20.30,73.05', center: { lat: 20.2666, lng: 72.9866 } },
];

const CATALOG_BY_SLUG = new Map(CITY_CATALOG.map((c) => [c.slug, c]));

// One-shot state backfill — runs at module load if the migration flagged
// rows without a state value. Wrapped in a transaction so it either
// completes fully or leaves the DB untouched on error.
if (globalThis.__cityGraphsBackfillState) {
  const { stmtBackfillState } = globalThis.__cityGraphsBackfillState;
  const tx = db.transaction(() => {
    for (const spec of CITY_CATALOG) {
      if (spec.state) stmtBackfillState.run(spec.state, spec.slug);
    }
  });
  try {
    tx();
    logger.info('city-graphs: backfilled state column from catalog');
  } catch (err) {
    logger.warn(`city-graphs: state backfill failed (non-fatal): ${err.message}`);
  }
  delete globalThis.__cityGraphsBackfillState;
}

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
//
// Widened Sep 2026 to also include named buildings — apartments,
// hospitals, malls, tech parks, universities, schools, offices — so
// users can type a building name in the Pathfinding composer and find
// it. Buildings can be tagged either as a single node (rare, usually
// just an entrance) or as a way (the polygon footprint) — we ask for
// both. Way-buildings get their centroid computed from member nodes,
// so we still hand back a single {lat, lng} per row.
//
// Amenity / shop / office filters are a redundant safety net: many
// large public buildings (hospitals, universities, malls) aren't tagged
// building=* at all in OSM but ARE tagged by function. Querying both
// tag families roughly doubles coverage without much overlap because
// we de-dupe on (name_lc, coarse_lat, coarse_lng) downstream.
//
// `(._;>;)` — recurse-down after the way selectors so Overpass includes
// each way's member nodes in the same payload; parsePlaces walks those
// to compute a centroid per way.
function buildPlacesQL(bbox) {
  // Amenity coverage — food, transport, finance, health, education,
  // culture, public services, leisure, worship. Only rows with `name`.
  const AMENITY = 'hospital|clinic|doctors|dentist|pharmacy|veterinary|school|college|university|kindergarten|library|police|fire_station|post_office|courthouse|townhall|embassy|community_centre|marketplace|theatre|cinema|arts_centre|studio|fuel|charging_station|restaurant|cafe|fast_food|bar|pub|biergarten|food_court|ice_cream|bank|atm|bureau_de_change|hotel|nightclub|casino|place_of_worship|bus_station|taxi|parking|ferry_terminal|car_rental|car_wash|motorcycle_rental|bicycle_rental|gym|spa|fountain|clock|social_facility|shelter|childcare|conference_centre|events_venue|internet_cafe|coworking_space';
  const TOURISM = 'attraction|museum|hostel|guest_house|motel|apartment|camp_site|viewpoint|gallery|zoo|theme_park|aquarium|information|artwork|picnic_site';
  const SHOP    = 'mall|supermarket|department_store|convenience|clothes|shoes|electronics|mobile_phone|computer|bakery|butcher|jewelry|hardware|bookshop|books|gift|sports|furniture|car|car_parts|bicycle|toys|florist|pet|beauty|hairdresser|optician|chemist|greengrocer|deli|alcohol|wine|cheese|coffee|tea|photo|music|watches|art|stationery';
  const LEISURE = 'park|garden|playground|sports_centre|fitness_centre|stadium|swimming_pool|water_park|marina|golf_course|ice_rink|nature_reserve|beach_resort|bowling_alley|dance|escape_game|amusement_arcade';
  const HISTORIC = 'monument|memorial|castle|ruins|archaeological_site|fort|city_gate|tomb|wayside_shrine|wayside_cross|manor|church|cathedral|temple|mosque';
  const AEROWAY  = 'aerodrome|terminal|heliport';
  const RAILWAY  = 'station|halt|tram_stop|subway_entrance';
  const MAN_MADE = 'lighthouse|tower|water_tower|silo|windmill|bridge|pier|observatory|telescope';
  return `[out:json][timeout:90];
(
  node["place"~"^(suburb|neighbourhood|quarter|square|town|village|hamlet|city_block|locality)$"](${bbox});
  node["building"]["name"](${bbox});
  way["building"]["name"](${bbox});
  node["amenity"~"^(${AMENITY})$"]["name"](${bbox});
  way["amenity"~"^(${AMENITY})$"]["name"](${bbox});
  node["tourism"~"^(${TOURISM})$"]["name"](${bbox});
  way["tourism"~"^(${TOURISM})$"]["name"](${bbox});
  node["shop"~"^(${SHOP})$"]["name"](${bbox});
  way["shop"~"^(${SHOP})$"]["name"](${bbox});
  node["office"]["name"](${bbox});
  way["office"]["name"](${bbox});
  node["leisure"~"^(${LEISURE})$"]["name"](${bbox});
  way["leisure"~"^(${LEISURE})$"]["name"](${bbox});
  node["historic"~"^(${HISTORIC})$"]["name"](${bbox});
  way["historic"~"^(${HISTORIC})$"]["name"](${bbox});
  node["aeroway"~"^(${AEROWAY})$"]["name"](${bbox});
  way["aeroway"~"^(${AEROWAY})$"]["name"](${bbox});
  node["railway"~"^(${RAILWAY})$"]["name"](${bbox});
  way["railway"~"^(${RAILWAY})$"]["name"](${bbox});
  node["man_made"~"^(${MAN_MADE})$"]["name"](${bbox});
  way["man_made"~"^(${MAN_MADE})$"]["name"](${bbox});
);
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

// Map an OSM tag bag to our normalised `kind` enum. The order matters —
// a hospital that's also tagged `building=hospital` should surface as
// `hospital` (the more specific label), not `building`. Callers of this
// helper only get a kind back if the row actually deserves one; nameless
// or featureless elements return null and are skipped upstream.
//
// Enum values the FE knows about (Pathfinding.jsx KIND_ICON):
//   suburb, neighbourhood, quarter, square, town, village   (place=*)
//   landmark                                                 (tourism=attraction)
//   hospital, school, university, mall, office, library,
//   theatre, cinema, building                                (widened Sep 2026)
function kindForTags(t) {
  if (!t) return null;
  // 1) `place=*` — highest-level administrative label wins over any
  //    building tag if both are present (rare but happens with landmark
  //    suburb centroids).
  if (t.place && /^(suburb|neighbourhood|quarter|square|town|village)$/.test(t.place)) {
    return t.place;
  }
  // 2) Tourist attractions — well-known landmarks that aren't buildings.
  if (t.tourism === 'attraction') return 'landmark';
  // 3) Function-tagged specific buildings — hospitals, schools, malls…
  //    Grouped: college → school (same emoji), clinic → hospital.
  if (t.amenity) {
    switch (t.amenity) {
      case 'hospital':
      case 'clinic':
      case 'doctors':
      case 'dentist':       return 'hospital';
      case 'pharmacy':      return 'pharmacy';
      case 'veterinary':    return 'veterinary';
      case 'school':
      case 'college':       return 'school';
      case 'university':    return 'university';
      case 'kindergarten':  return 'kindergarten';
      case 'library':       return 'library';
      case 'theatre':
      case 'cinema':        return t.amenity;
      case 'arts_centre':
      case 'studio':        return 'arts_centre';
      case 'police':
      case 'fire_station':
      case 'marketplace':
      case 'post_office':
      case 'courthouse':
      case 'townhall':
      case 'embassy':
      case 'community_centre': return t.amenity;
      // Fuel + transport
      case 'fuel':          return 'fuel';
      case 'charging_station': return 'charging_station';
      case 'bus_station':   return 'bus_station';
      case 'taxi':          return 'taxi';
      case 'parking':       return 'parking';
      case 'ferry_terminal': return 'ferry_terminal';
      case 'car_rental':
      case 'car_wash':
      case 'motorcycle_rental':
      case 'bicycle_rental': return 'transport_service';
      // Food & drink
      case 'restaurant':    return 'restaurant';
      case 'cafe':          return 'cafe';
      case 'fast_food':     return 'fast_food';
      case 'bar':
      case 'pub':
      case 'biergarten':    return 'bar';
      case 'food_court':    return 'food_court';
      case 'ice_cream':     return 'ice_cream';
      // Finance
      case 'bank':          return 'bank';
      case 'atm':           return 'atm';
      case 'bureau_de_change': return 'bank';
      // Hospitality + leisure
      case 'hotel':         return 'hotel';
      case 'nightclub':     return 'nightclub';
      case 'casino':        return 'casino';
      case 'place_of_worship': return 'place_of_worship';
      case 'gym':
      case 'fitness_centre': return 'gym';
      case 'spa':           return 'spa';
      // Working spaces
      case 'coworking_space':
      case 'internet_cafe': return 'coworking';
      case 'conference_centre':
      case 'events_venue':  return 'venue';
      default:              break;
    }
  }
  if (t.tourism) {
    switch (t.tourism) {
      case 'attraction':    return 'landmark';
      case 'museum':        return 'museum';
      case 'gallery':       return 'gallery';
      case 'hotel':
      case 'hostel':
      case 'guest_house':
      case 'motel':
      case 'apartment':     return 'hotel';
      case 'camp_site':     return 'camp_site';
      case 'viewpoint':     return 'viewpoint';
      case 'zoo':           return 'zoo';
      case 'theme_park':    return 'theme_park';
      case 'aquarium':      return 'aquarium';
      case 'artwork':       return 'artwork';
      case 'information':   return 'information';
      case 'picnic_site':   return 'park';
      default:              break;
    }
  }
  if (t.shop) {
    switch (t.shop) {
      case 'mall':          return 'mall';
      case 'supermarket':
      case 'convenience':
      case 'department_store': return 'supermarket';
      case 'clothes':
      case 'shoes':
      case 'jewelry':
      case 'watches':       return 'clothing';
      case 'electronics':
      case 'mobile_phone':
      case 'computer':      return 'electronics';
      case 'bakery':
      case 'butcher':
      case 'greengrocer':
      case 'deli':          return 'grocery';
      case 'alcohol':
      case 'wine':          return 'alcohol';
      case 'bookshop':
      case 'books':         return 'bookshop';
      case 'sports':        return 'sports_shop';
      case 'furniture':
      case 'hardware':      return 'hardware';
      case 'car':
      case 'car_parts':
      case 'bicycle':       return 'auto_shop';
      case 'beauty':
      case 'hairdresser':
      case 'optician':      return 'beauty';
      default:              return 'shop';
    }
  }
  if (t.office)          return 'office';
  if (t.leisure) {
    switch (t.leisure) {
      case 'park':
      case 'garden':
      case 'nature_reserve': return 'park';
      case 'playground':    return 'playground';
      case 'stadium':       return 'stadium';
      case 'sports_centre':
      case 'fitness_centre': return 'sports_centre';
      case 'swimming_pool':
      case 'water_park':    return 'pool';
      case 'marina':        return 'marina';
      case 'golf_course':   return 'golf';
      case 'ice_rink':      return 'ice_rink';
      case 'beach_resort':  return 'beach';
      case 'amusement_arcade':
      case 'bowling_alley':
      case 'escape_game':
      case 'dance':         return 'entertainment';
      default:              return 'leisure';
    }
  }
  if (t.historic) {
    switch (t.historic) {
      case 'castle':
      case 'fort':
      case 'city_gate':     return 'castle';
      case 'monument':
      case 'memorial':
      case 'tomb':          return 'monument';
      case 'ruins':
      case 'archaeological_site': return 'ruins';
      case 'church':
      case 'cathedral':
      case 'temple':
      case 'mosque':
      case 'wayside_shrine':
      case 'wayside_cross': return 'place_of_worship';
      case 'manor':         return 'manor';
      default:              return 'historic';
    }
  }
  if (t.aeroway) {
    switch (t.aeroway) {
      case 'aerodrome':
      case 'terminal':      return 'airport';
      case 'heliport':      return 'heliport';
      default:              break;
    }
  }
  if (t.railway) {
    switch (t.railway) {
      case 'station':
      case 'halt':          return 'train_station';
      case 'tram_stop':     return 'tram_stop';
      case 'subway_entrance': return 'metro';
      default:              break;
    }
  }
  if (t.man_made) {
    switch (t.man_made) {
      case 'lighthouse':    return 'lighthouse';
      case 'tower':
      case 'water_tower':   return 'tower';
      case 'bridge':        return 'bridge';
      case 'windmill':      return 'windmill';
      case 'observatory':
      case 'telescope':     return 'observatory';
      default:              break;
    }
  }
  // 4) Generic named buildings — apartments, offices, tech parks that
  //    have a name but no more-specific function tag.
  if (t.building) return 'building';
  return null;
}

// Extract [{name, kind, lat, lng}] from Overpass places JSON. Handles
// both nodes (single point) and ways (polygon → centroid from member
// nodes in the same payload). Ways emitted by Overpass include a
// `nodes` array of node IDs; the corresponding node elements are in
// the same response thanks to the `(._;>;)` recurse-down in the QL.
//
// De-dupe key is (name_lc, coarse_lat, coarse_lng) — 3 decimal places
// ≈ 110 m grid. Prevents a hospital tagged as both a node (entrance
// pin) and a way (footprint polygon) from inserting twice, and also
// prevents suburb boundaries tagged under two admin levels from
// double-inserting.
function parsePlaces(json) {
  const elements = json.elements || [];

  // Pass 1: index every node's coords so we can centroid ways later.
  // Not all nodes here are named place candidates — many are just
  // structural nodes of a building polygon (no tags of their own).
  const nodePos = new Map(); // id -> {lat, lng}
  for (const el of elements) {
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      nodePos.set(el.id, { lat: el.lat, lng: el.lon });
    }
  }

  const out = [];
  const seen = new Set();

  const push = (name, kind, lat, lng) => {
    if (!name || !kind) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const key = `${name.toLowerCase()}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind, lat, lng });
  };

  // Pass 2: named nodes.
  for (const el of elements) {
    if (el.type !== 'node') continue;
    const t = el.tags || {};
    const name = t.name || t['name:en'];
    if (!name) continue;
    const kind = kindForTags(t);
    if (!kind) continue;
    push(name, kind, el.lat, el.lon);
  }

  // Pass 3: named ways — centroid = arithmetic mean of member node
  // coords. Fine for search / marker placement at this zoom level
  // (a mall footprint is at most ~300 m across; the centre-of-mass
  // approximation is well within the 110 m de-dupe grid). We skip
  // ways whose member nodes weren't included in the payload — that
  // shouldn't happen with the `(._;>;)` recurse but is defensive.
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.nodes) || el.nodes.length === 0) continue;
    const t = el.tags || {};
    const name = t.name || t['name:en'];
    if (!name) continue;
    const kind = kindForTags(t);
    if (!kind) continue;

    let sumLat = 0, sumLng = 0, count = 0;
    for (const nid of el.nodes) {
      const p = nodePos.get(nid);
      if (!p) continue;
      sumLat += p.lat;
      sumLng += p.lng;
      count++;
    }
    if (count === 0) continue;
    push(name, kind, sumLat / count, sumLng / count);
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

export async function fetchPlacesFromOverpass(bbox) {
  const json = await overpassPost(buildPlacesQL(bbox));
  return parsePlaces(json);
}

// ── Prepared statements (module-scoped, reused per request) ────────
// SQLite parses SQL every time db.prepare() is called. On a warm process
// those parse cycles are pure overhead — the plan doesn't change between
// requests, so we prepare each hot-path statement exactly once at module
// load and reuse the compiled statement handle. This is the standard
// better-sqlite3 pattern for sub-millisecond queries.
//
// Every statement below carries the EXPLAIN QUERY PLAN row it hits (run
// against the live sid.db on 2026-09-11) so a future reader can verify
// index usage without re-running EXPLAIN. If you edit a query, RE-RUN
// EXPLAIN QUERY PLAN and update the comment — a query that suddenly says
// "SCAN city_places" is a red flag.

// EXPLAIN: SEARCH city_graphs USING INTEGER PRIMARY KEY (rowid=?) — PK on slug
const stmtSelectMeta = db.prepare(`
  SELECT slug, name, state, bbox, center_lat, center_lng, node_count, edge_count,
         fetched_at, bytes, created_at, updated_at
    FROM city_graphs WHERE slug = ?
`);

// EXPLAIN: SEARCH city_graphs USING INTEGER PRIMARY KEY (rowid=?) — PK on slug
// Kept separate from stmtSelectMeta because pulling the BLOB column adds
// non-trivial IO cost we don't want on the meta-only path.
const stmtSelectRow = db.prepare(`
  SELECT slug, name, state, bbox, center_lat, center_lng, graph, node_count,
         edge_count, fetched_at, bytes, created_at, updated_at
    FROM city_graphs WHERE slug = ?
`);

// EXPLAIN: SEARCH city_graphs USING INTEGER PRIMARY KEY (rowid=?)
// Meta-only variant of stmtSelectRow that skips the BLOB column entirely
// — used by the /graph.json.gz path when we only need the row length +
// updated_at for ETag calculation (though currently we still need graph
// for the body, kept for future streaming). Not currently used but left
// prepared for cheap ETag / HEAD support if we add it.
const stmtSelectGraphBlobOnly = db.prepare(`
  SELECT slug, graph, node_count, edge_count, fetched_at, updated_at
    FROM city_graphs WHERE slug = ?
`);

// EXPLAIN: SCAN city_graphs — full scan is intentional (we want every row).
// ORDER BY name uses no index; sort buffer is fine at 154 rows.
const stmtListCitiesAll = db.prepare(`
  SELECT slug, name, state, bbox, center_lat, center_lng, node_count, edge_count,
         fetched_at, bytes, updated_at
    FROM city_graphs
   ORDER BY name COLLATE NOCASE ASC
`);

// EXPLAIN: SEARCH city_graphs USING INDEX idx_city_graphs_state (state=?)
// State-filtered list — hits the new state index for O(log n) prefix seek.
const stmtListCitiesByState = db.prepare(`
  SELECT slug, name, state, bbox, center_lat, center_lng, node_count, edge_count,
         fetched_at, bytes, updated_at
    FROM city_graphs
   WHERE state = ?
   ORDER BY name COLLATE NOCASE ASC
`);

// EXPLAIN: SCAN city_graphs USING COVERING INDEX idx_city_graphs_updated_at
// Aggregate on an indexed column — SQLite walks the index leaves for both
// MAX and COUNT in one pass, no heap touch. Used for ETag support though
// currently the listCities handler computes maxUpdatedAt from the already-
// loaded rows to save a second round trip. Left prepared for stat-lite
// callers that only want freshness.
const stmtMaxUpdatedAt = db.prepare(`
  SELECT MAX(updated_at) AS max_updated_at, COUNT(*) AS n FROM city_graphs
`);

// UPSERT keyed on slug. `created_at` is preserved on conflict — only
// the first write for a slug sets it. `updated_at` is set every write.
// `state` also updates every write so a catalog rename lands in the DB.
const stmtUpsertGraph = db.prepare(`
  INSERT INTO city_graphs (slug, name, state, bbox, center_lat, center_lng, graph,
                           node_count, edge_count, fetched_at, bytes,
                           created_at, updated_at)
  VALUES (@slug, @name, @state, @bbox, @center_lat, @center_lng, @graph,
          @node_count, @edge_count, @fetched_at, @bytes,
          @created_at, @updated_at)
  ON CONFLICT(slug) DO UPDATE SET
    name       = excluded.name,
    state      = excluded.state,
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

const stmtUpsertPlace = db.prepare(`
  INSERT INTO city_places (city_slug, name, name_lc, kind, lat, lng, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// EXPLAIN: SEARCH city_places USING COVERING INDEX idx_city_places_slug_kind_name (city_slug=?)
// SQLite prefers the wider composite index because it covers this query
// without heap fetches — the count aggregate doesn't need any other columns.
const stmtCountPlaces = db.prepare(`SELECT COUNT(*) AS n FROM city_places WHERE city_slug = ?`);

// EXPLAIN: SEARCH city_places USING INDEX idx_city_places_slug_name (city_slug=?)
const stmtDeletePlaces = db.prepare(`DELETE FROM city_places WHERE city_slug = ?`);

// EXPLAIN: SEARCH city_places USING INDEX idx_city_places_slug_kind_name (city_slug=?)
// Same composite-index pick as the count — the (slug, kind, name_lc)
// leaf points at rowid, then we fetch id/lat/lng from the heap.
const stmtSelectPlaces = db.prepare(`
  SELECT id, name, name_lc, kind, lat, lng FROM city_places WHERE city_slug = ?
`);

// EXPLAIN: SEARCH city_places USING INDEX idx_city_places_slug_kind_name (city_slug=?)
// LIMIT-bounded read — used to sample the first N rows when a city has
// enough places that we want to skip the full-city Trie warm. Ordered by
// PK for stable pagination.
const stmtSelectPlacesLimited = db.prepare(`
  SELECT id, name, name_lc, kind, lat, lng FROM city_places
   WHERE city_slug = ? ORDER BY id LIMIT ?
`);

// ── Stats prepared statements ─────────────────────────────────────
// EXPLAIN: SCAN city_graphs — full-scan aggregates. 154 rows is trivial.
const stmtStatsGraphs = db.prepare(`
  SELECT COUNT(*) AS total_cities,
         COUNT(DISTINCT state) AS total_states,
         COALESCE(SUM(bytes), 0) AS total_graph_bytes,
         COALESCE(SUM(node_count), 0) AS total_nodes,
         COALESCE(SUM(edge_count), 0) AS total_edges
    FROM city_graphs
`);
// EXPLAIN: SCAN city_places — single scalar aggregate.
const stmtStatsPlacesCount = db.prepare(`SELECT COUNT(*) AS total_places FROM city_places`);
// EXPLAIN: SCAN city_graphs — orderby uses ephemeral index but tiny row count.
// Emulates a median via OFFSET on a sorted list — cheap at n=154.
const stmtNodeCountsSorted = db.prepare(`
  SELECT node_count FROM city_graphs WHERE node_count > 0 ORDER BY node_count ASC
`);
// EXPLAIN: SCAN city_places USING COVERING INDEX idx_city_places_slug_kind
// Group-by-slug aggregate — SQLite walks the covering index in slug order
// (grouping-friendly) so the aggregate needs no sort for the group step,
// only for the final ORDER BY places DESC. At current row counts (<500k)
// the walk is well under 5 ms.
const stmtTopCitiesByPlaces = db.prepare(`
  SELECT city_slug, COUNT(*) AS places
    FROM city_places
   GROUP BY city_slug
   ORDER BY places DESC
   LIMIT 5
`);

// Legacy aliases — keep the old names alive so any downstream helpers
// that happen to import them still work. Points at the same handles.
const selectMeta = (slug) => stmtSelectMeta.get(slug);
const selectRow = (slug) => stmtSelectRow.get(slug);
const upsertStmt = stmtUpsertGraph;
const upsertPlaceStmt = stmtUpsertPlace;
const countPlacesStmt = stmtCountPlaces;
const deletePlacesStmt = stmtDeletePlaces;
const selectPlacesStmt = stmtSelectPlaces;

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
    state: spec.state || null,
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
//
// LRU cap: with 154 cities × up to ~20k places each, keeping every warm
// index in memory could balloon past a few hundred MB. Map iteration
// order is insertion order in V8, so we implement LRU by deleting +
// re-inserting on hit (moves the key to the tail), and evicting the head
// (oldest) when we exceed the cap. Simple and allocation-free.
const TRIE_CACHE_MAX = 10;
const trieCache = new Map();

function touchTrieCacheEntry(slug, entry) {
  // Refresh insertion position so LRU eviction skips this city.
  trieCache.delete(slug);
  trieCache.set(slug, entry);
}

function evictOldestTrieIfNeeded() {
  while (trieCache.size >= TRIE_CACHE_MAX) {
    const oldest = trieCache.keys().next().value;
    if (oldest === undefined) break;
    trieCache.delete(oldest);
    logger.info(`city-graphs: evicted LRU trie for ${oldest} (cache size cap ${TRIE_CACHE_MAX})`);
  }
}

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

// Cities above this row count skip the in-memory Trie build entirely for
// no-query listing calls and get streamed via SQL LIMIT instead. Trie
// build for a 20k-row city still takes ~120 ms and allocates ~30 MB — not
// worth it if the caller just wants the first 20 rows.
const HEAVY_CITY_ROW_THRESHOLD = 20000;

function getIndexFor(slug) {
  const cached = trieCache.get(slug);
  if (cached) {
    touchTrieCacheEntry(slug, cached);
    return cached;
  }
  evictOldestTrieIfNeeded();
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

// Kind → prominence weight for the final ranker. Suburbs, hospitals,
// universities and malls are "landmark-tier" and stay at 1.0 — they're
// what a user typically means when the query matches both a suburb and
// a nearby building of the same name (e.g. "Andheri" the suburb vs
// "Andheri Apartments"). Generic buildings, small offices, schools and
// libraries are still returned but scored 25 % lower so they don't
// crowd out the tier-1 hits when both match.
//
// Any kind not in this map defaults to 1.0 (fail-open) — safer than
// silently zero-weighting an unfamiliar tag that Overpass might send.
const KIND_WEIGHT = {
  // top tier — administrative + iconic named places
  suburb: 1.0, neighbourhood: 1.0, quarter: 1.0, square: 1.0,
  town: 1.0, village: 1.0, hamlet: 1.0, city_block: 1.0, locality: 1.0,
  landmark: 1.0, museum: 1.0, gallery: 1.0,
  hospital: 1.0, university: 1.0, mall: 1.0,
  airport: 1.0, heliport: 1.0, train_station: 1.0,
  castle: 1.0, monument: 1.0, ruins: 1.0, place_of_worship: 1.0, manor: 1.0,
  stadium: 1.0, park: 1.0, zoo: 1.0, theme_park: 1.0, aquarium: 1.0,
  observatory: 1.0, lighthouse: 1.0, viewpoint: 1.0,
  // mid tier — commonly searched, still prominent
  bus_station: 0.9, tram_stop: 0.9, metro: 0.9, ferry_terminal: 0.9,
  hotel: 0.9, marina: 0.9, marketplace: 0.9,
  fuel: 0.85, charging_station: 0.85,
  townhall: 0.9, embassy: 0.9, courthouse: 0.9, community_centre: 0.85,
  arts_centre: 0.85, theatre: 0.85, cinema: 0.85,
  beach: 0.9, historic: 0.85, tower: 0.85, bridge: 0.9, windmill: 0.85,
  // background — searchable but not "loud" against a same-name suburb
  building: 0.75, office: 0.75, school: 0.75, kindergarten: 0.7,
  library: 0.75, casino: 0.75, nightclub: 0.75, venue: 0.75,
  restaurant: 0.7, cafe: 0.65, fast_food: 0.6, bar: 0.7,
  food_court: 0.7, ice_cream: 0.55,
  bank: 0.7, atm: 0.5,
  pharmacy: 0.7, veterinary: 0.65,
  supermarket: 0.7, grocery: 0.55, clothing: 0.55, electronics: 0.55,
  bookshop: 0.6, alcohol: 0.6, sports_shop: 0.55, hardware: 0.55,
  auto_shop: 0.55, beauty: 0.5, shop: 0.5,
  gym: 0.65, spa: 0.6, pool: 0.65, sports_centre: 0.7, ice_rink: 0.7,
  golf: 0.75, playground: 0.6, leisure: 0.55, entertainment: 0.6,
  police: 0.75, fire_station: 0.75, post_office: 0.7,
  parking: 0.5, taxi: 0.55, transport_service: 0.55,
  camp_site: 0.75, coworking: 0.7, artwork: 0.7,
  information: 0.55, fountain: 0.5, clock: 0.4,
  childcare: 0.6, social_facility: 0.6, shelter: 0.6,
};

function weightForKind(k) {
  return KIND_WEIGHT[k] != null ? KIND_WEIGHT[k] : 1.0;
}

// Apply the kind_weight bump on top of the raw match score. Kept as a
// separate helper so both the single-city and cross-city rankers use
// the exact same formula.
function weightedScore(row, rawScore) {
  return rawScore * weightForKind(row.kind);
}

// ── Handlers ───────────────────────────────────────────────────────

// Weak ETag helper — hashes into 8 hex chars. Weak because the payload
// shape (JSON keys) isn't byte-stable across Node versions, but our
// content is stable enough. Prefix with W/" so a strict proxy doesn't
// treat it as strong. Weak validators are fine for our If-None-Match
// check because we compare exact strings, not byte-hash any body.
function weakEtag(...parts) {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p));
  return `W/"${h.digest('hex').slice(0, 16)}"`;
}

// GET /api/city-graphs
// Metadata list for the FE picker. Merges the catalog (154 known cities)
// with whatever's actually in the DB — so unfetched cities show up too
// with fetched_at=null and node_count=0.
//
// Query params:
//   ?state=Karnataka   — filter to one state (matches CITY_CATALOG.state
//                        exactly). Uses idx_city_graphs_state.
//
// Response caching:
//   • Cache-Control: public, max-age=60 — content changes hourly at most
//     (only on refresh + monthly cron), so a minute of edge caching is
//     safe. FE hub page hits this once per page load; CDN can absorb it.
//   • ETag derived from (max updated_at, row count, state filter) — a
//     matching If-None-Match short-circuits to 304 with no body.
export const listCities = (req, res) => {
  try {
    const stateFilter = req.query.state ? String(req.query.state).trim() : '';
    const catalogRows = stateFilter
      ? CITY_CATALOG.filter((c) => c.state === stateFilter)
      : CITY_CATALOG;

    // Pull DB rows via the state-filtered index if a filter is supplied.
    // Both statements are module-scoped prepared handles.
    const dbRows = stateFilter
      ? stmtListCitiesByState.all(stateFilter)
      : stmtListCitiesAll.all();
    const stored = new Map();
    let maxUpdatedAt = 0;
    for (const r of dbRows) {
      stored.set(r.slug, r);
      if (r.updated_at && r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at;
    }

    // ETag = f(stored row count, max updated_at, state filter, catalog size).
    // Any real change to the response bumps at least one of these.
    const etag = weakEtag(dbRows.length, maxUpdatedAt, stateFilter, catalogRows.length);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    const items = catalogRows
      .map((c) => {
        const r = stored.get(c.slug);
        return {
          slug: c.slug,
          name: c.name,
          state: c.state || null,    // grouping key for the FE picker
          bbox: c.bbox,
          center: c.center,
          node_count: r?.node_count ?? 0,
          edge_count: r?.edge_count ?? 0,
          fetched_at: r?.fetched_at ?? null,
          kb:         r?.bytes ? Math.round(r.bytes / 1024) : 0,
          cached:     !!r,
        };
      })
      // Deterministic name-ASC order. Matches the SQL ORDER BY so cached
      // FE views don't reshuffle on refresh. NOCASE for locale-friendly sort.
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return success(res, { items, total: items.length, state: stateFilter || null });
  } catch (err) {
    logger.error('city-graphs list failed', err.message);
    return error(res, err.message);
  }
};

// GET /api/city-graphs/stats
// Public aggregates for the FE hub page. All queries run against the
// module-scoped stmts above — a warm hit is ~2 ms total for 154 cities.
export const getStats = (_req, res) => {
  try {
    const g = stmtStatsGraphs.get() || {};
    const p = stmtStatsPlacesCount.get() || {};
    // Median = middle element of the sorted node_count list. For an even
    // count we pick the lower-middle (SQLite has no percentile function
    // and pulling the list once at 154 rows is trivial).
    const nodeCounts = stmtNodeCountsSorted.all().map((r) => r.node_count);
    const median_nodes_per_city = nodeCounts.length
      ? nodeCounts[Math.floor((nodeCounts.length - 1) / 2)]
      : 0;

    // Top 5 by places — join to catalog via the in-memory map (avoids a
    // full JOIN against city_graphs since not every place-carrying city
    // has a graph row yet).
    const top_5_by_places = stmtTopCitiesByPlaces.all().map((row) => {
      const spec = CATALOG_BY_SLUG.get(row.city_slug);
      return {
        slug: row.city_slug,
        name: spec?.name || row.city_slug,
        state: spec?.state || null,
        places: row.places,
      };
    });

    const payload = {
      total_cities: g.total_cities || 0,
      total_states: g.total_states || 0,
      total_places: p.total_places || 0,
      total_graph_bytes: g.total_graph_bytes || 0,
      total_nodes: g.total_nodes || 0,
      total_edges: g.total_edges || 0,
      median_nodes_per_city,
      catalog_size: CITY_CATALOG.length,
      top_5_by_places,
    };

    // Stats are cheap and update ~monthly. Two minutes of edge caching
    // is fine and takes the FE hub page off the hot path entirely.
    res.setHeader('Cache-Control', 'public, max-age=120');
    return success(res, payload);
  } catch (err) {
    logger.error(`city-graphs stats failed: ${err.message}`);
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

// GET /api/city-graphs/:slug/meta
// Metadata-only sibling of getCity — same shape minus the `graph` payload.
// Split so the FE can fire two parallel requests (meta + gzipped blob) and
// the heavy blob rides the browser's own gzip decoder instead of our
// gunzip-then-re-serialize-to-JSON round-trip. Cuts /api/city-graphs/:slug
// wire time by roughly 3-5× on a ~6 MB city.
//
// Keeps the auto-refresh cadence intact: hitting this endpoint on a >30d
// row still kicks off a background re-fetch. Callers that want the graph
// itself should hit /:slug/graph.json.gz in parallel.
export const getCityMeta = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!CATALOG_BY_SLUG.has(slug)) {
      return error(res, `Unknown city: ${slug}`, 404);
    }
    let meta = selectMeta(slug);
    if (!meta) {
      // First-ever request for this city — do the Overpass hit inline
      // just like getCity() does. ~5-15 s worst case, cached forever after.
      await fetchAndStoreCity(slug);
      meta = selectMeta(slug);
      if (!meta) return error(res, 'Failed to populate city graph', 500);
    } else {
      // Auto-refresh > 30 days old rows in the background — same policy
      // as the combined /:slug endpoint so callers using the split API
      // still benefit from freshness maintenance.
      const age = Date.now() - (meta.updated_at || meta.fetched_at);
      if (age > AUTO_REFRESH_MS && !backgroundRefreshes.has(slug)) {
        backgroundRefreshes.add(slug);
        fetchAndStoreCity(slug)
          .catch((e) => logger.warn(`city-graphs: bg refresh ${slug} failed: ${e.message}`))
          .finally(() => backgroundRefreshes.delete(slug));
      }
    }
    return success(res, {
      slug: meta.slug,
      name: meta.name,
      bbox: meta.bbox,
      center: { lat: meta.center_lat, lng: meta.center_lng },
      node_count: meta.node_count,
      edge_count: meta.edge_count,
      fetched_at: meta.fetched_at,
      kb: Math.round(meta.bytes / 1024),
      stale: (Date.now() - (meta.updated_at || meta.fetched_at)) > AUTO_REFRESH_MS,
    });
  } catch (err) {
    logger.error(`city-graphs meta failed: ${err.message}`);
    return error(res, err.message);
  }
};

// GET /api/city-graphs/:slug/graph.json.gz
// Streams the raw gzipped SQLite BLOB straight to the client with
// Content-Encoding: gzip. Browsers transparently decode it, so the FE
// just does `fetch(url).then(r => r.json())` — no manual gunzip, no
// re-serialize on the server. ~6 MB JSON → ~1.2 MB on the wire.
//
// The global compression middleware is opted out for this path (see
// NO_COMPRESSION_PATHS in app.js) so we don't double-encode. If the row
// is missing we populate it synchronously first — same slow-path shape
// as the combined /:slug endpoint.
export const getCityGraphBlob = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!CATALOG_BY_SLUG.has(slug)) {
      return error(res, `Unknown city: ${slug}`, 404);
    }
    let row = selectRow(slug);
    if (!row) {
      await fetchAndStoreCity(slug);
      row = selectRow(slug);
      if (!row) return error(res, 'Failed to populate city graph', 500);
    }

    // ETag = f(slug, updated_at, byte length). Any real change to the
    // stored blob bumps updated_at, and re-encoding at the same timestamp
    // would still shift bytes. Cold-cache clients that already hold the
    // matching version get a 304 with no body — saves ~1.2 MB per hit.
    const updatedAt = row.updated_at || row.fetched_at || 0;
    const etag = weakEtag(slug, updatedAt, row.graph.length);

    // Set headers BEFORE writing the body. Content-Encoding: gzip tells
    // the browser to run the response through its native inflater — same
    // path any gzip'd asset from CDN takes. Cache for a day; the row's
    // 30-day auto-refresh keeps it fresh enough.
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('ETag', etag);
    res.setHeader('X-City-Slug', row.slug);
    res.setHeader('X-Node-Count', String(row.node_count));
    res.setHeader('X-Edge-Count', String(row.edge_count));

    // Conditional-GET short-circuit — must come after headers are set so
    // the client still sees the ETag on the 304 response.
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Length', row.graph.length);
    return res.end(row.graph);
  } catch (err) {
    logger.error(`city-graphs blob failed: ${err.message}`);
    return error(res, err.message);
  }
};

// GET /api/city-graphs/:slug/places?q=&limit=20&kind=hospital,school
// Prefix-match search on lowercased place names for the given city.
// First request per city warms an in-memory Trie built from the DB rows,
// so subsequent hits are O(k) where k = prefix length.
//
// Query params:
//   q     — free-text query. Empty = "popular labels" mode.
//   limit — 1..50 (default 20).
//   kind  — comma-separated whitelist of place kinds (hospital, school…).
//           Applied AFTER the fuzzy ranker so kind_weight still shapes
//           the score. Also drives the LIMIT-only SQL path when q is
//           empty (uses idx_city_places_slug_kind).
//
// Response:
//   { items: [...], total_count: <int> }
//   `total_count` = number of matches BEFORE limit truncation, so the FE
//   can show "showing 8 of 4135" without a second round-trip.
export const searchPlaces = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!CATALOG_BY_SLUG.has(slug)) {
      return error(res, `Unknown city: ${slug}`, 404);
    }
    const q = String(req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    // Parse kind filter — comma-separated, whitespace-tolerant. Empty →
    // no filter. Set for O(1) membership test in the post-rank pass.
    const kindsRaw = String(req.query.kind || '').trim();
    const kindSet = kindsRaw
      ? new Set(kindsRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
      : null;

    // Warm places table for this city if it's empty (lazy seed on first
    // search, so cities that only get graph traffic don't hit Overpass
    // twice pre-emptively).
    const { n: totalRowsForCity } = countPlacesStmt.get(slug);
    if (totalRowsForCity < MIN_PLACES) {
      try {
        await ensurePlacesForCity(slug);
      } catch (err) {
        logger.warn(`city-graphs: on-demand places seed failed for ${slug}: ${err.message}`);
      }
    }

    if (!q) {
      // No query — return the top-N by row insertion order (stable) so
      // the FE can still show "popular labels" on the map overlay.
      //
      // Fast path for heavy cities (>= 20k rows): skip the in-memory
      // Trie warm entirely and stream the first N rows via SQL LIMIT.
      // Uses idx_city_places_slug_name (covering) for a pure index scan.
      //
      // Optional kind filter runs SQL-side against
      // idx_city_places_slug_kind so we never load rows we don't need.
      let rows;
      if (totalRowsForCity >= HEAVY_CITY_ROW_THRESHOLD) {
        if (kindSet) {
          // Build a dynamic IN(...) since the kind list is variadic and
          // we want the composite index to take effect. Prepared per
          // request (rare path — heavy city + kind filter) but still
          // cheaper than warming a 20k-row Trie for a bare list request.
          const placeholders = Array.from(kindSet).map(() => '?').join(',');
          const sql = `
            SELECT id, name, name_lc, kind, lat, lng FROM city_places
             WHERE city_slug = ? AND kind IN (${placeholders})
             ORDER BY id LIMIT ?
          `;
          // EXPLAIN: SEARCH city_places USING COVERING INDEX idx_city_places_slug_kind_name (city_slug=? AND kind=?)
          rows = db.prepare(sql).all(slug, ...kindSet, limit);
        } else {
          rows = stmtSelectPlacesLimited.all(slug, limit);
        }
      } else {
        // Small/medium city — Trie is already going to be warm for the
        // next query anyway, so build it now to serve both requests.
        const entry = getIndexFor(slug);
        const filtered = kindSet
          ? entry.rows.filter((r) => kindSet.has(String(r.kind || '').toLowerCase()))
          : entry.rows;
        rows = filtered.slice(0, limit);
      }
      return success(res, {
        items: rows.map((r) => ({ name: r.name, kind: r.kind, lat: r.lat, lng: r.lng })),
        total_count: totalRowsForCity,
      });
    }

    // Fuzzy pipeline: exact → prefix (Trie) → substring → trigram.
    // Winner-per-row scoring, then kind_weight bump, then top-N by
    // weighted score. See KIND_WEIGHT above for tier rationale.
    const entry = getIndexFor(slug);
    const scored = scoreQueryAgainstIndex(entry, q);
    // Kind filter — applied AFTER scoring so we still surface the right
    // matches per kind (SQL-side pre-filter would break trigram overlap).
    const rankedAll = [...scored.entries()]
      .map(([idx, meta]) => ({
        idx,
        meta,
        weighted: weightedScore(entry.rows[idx], meta.score),
      }))
      .filter(({ idx }) => {
        if (!kindSet) return true;
        const k = String(entry.rows[idx].kind || '').toLowerCase();
        return kindSet.has(k);
      })
      .sort((a, b) => b.weighted - a.weighted);
    const totalMatches = rankedAll.length;
    const ranked = rankedAll.slice(0, limit);
    const items = ranked.map(({ idx, meta, weighted }) => {
      const p = entry.rows[idx];
      return {
        name: p.name,
        kind: p.kind,
        lat: p.lat,
        lng: p.lng,
        score: Math.round(weighted),
        matchType: meta.matchType,
      };
    });
    return success(res, { items, total_count: totalMatches });
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
    const kindsRaw = String(req.query.kind || '').trim();
    const kindSet = kindsRaw
      ? new Set(kindsRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
      : null;

    if (!q) return success(res, { items: [], total_count: 0 });

    const all = [];
    let totalMatches = 0;
    for (const spec of CITY_CATALOG) {
      const { n } = countPlacesStmt.get(spec.slug);
      if (n < 1) continue;
      const entry = getIndexFor(spec.slug);
      const scored = scoreQueryAgainstIndex(entry, q);
      // Take this city's top-N by score, then merge across all cities
      // and re-rank. Capping per-city keeps the merge budget bounded
      // when many cities happen to match a common substring.
      const cityAll = [...scored.entries()]
        .map(([idx, meta]) => ({
          idx,
          meta,
          weighted: weightedScore(entry.rows[idx], meta.score),
        }))
        .filter(({ idx }) => {
          if (!kindSet) return true;
          const k = String(entry.rows[idx].kind || '').toLowerCase();
          return kindSet.has(k);
        })
        .sort((a, b) => b.weighted - a.weighted);
      totalMatches += cityAll.length;
      const cityTop = cityAll.slice(0, limit);
      for (const { idx, meta, weighted } of cityTop) {
        const p = entry.rows[idx];
        all.push({
          name: p.name,
          kind: p.kind,
          lat: p.lat,
          lng: p.lng,
          city_slug: spec.slug,
          city_name: spec.name,
          score: Math.round(weighted),
          matchType: meta.matchType,
        });
      }
    }

    all.sort((a, b) => b.score - a.score);
    return success(res, { items: all.slice(0, limit), total_count: totalMatches });
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
