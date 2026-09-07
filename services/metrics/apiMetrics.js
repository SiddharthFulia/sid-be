// Per-endpoint API usage metrics — hourly aggregates in SQLite.
//
// Wraps every `/api/*` route via one Express middleware. Records:
//   - calls        : total requests observed
//   - errors       : responses with statusCode >= 400
//   - cache_hits   : responses that set `X-Cache-Hit: 1`
//   - latency_sum  : ms sum (divide by calls for avg)
//   - latency_max  : ms max (rough proxy for p95 without percentile tables)
//   - status_501   : count of "auth-not-configured" / "not implemented" replies
//
// Storage strategy — hourly buckets, not per-request. If we logged every
// request the row count would grow at ~1M/day; with hourly buckets the
// same volume shrinks to ~5k rows/day (endpoints × 24) and stays
// aggregatable indefinitely. Rows keyed on (endpoint, hour_bucket) with a
// UNIQUE constraint so the middleware can UPSERT in a single statement.
//
// Failure isolation — the whole recording path is wrapped in try/catch.
// If SQLite is locked, the middleware misses a data point rather than
// throwing 500 at the user. Nothing here is on the request's critical path.

import { db } from '../aiVideo/db.js';
import logger from '../../helpers/logger.js';

// ── Schema (created lazily on first import) ────────────────────────
// idempotent — safe to re-run every boot. Matches the DDL in the task brief.
db.exec(`
  CREATE TABLE IF NOT EXISTS api_metrics (
    id INTEGER PRIMARY KEY,
    endpoint TEXT NOT NULL,
    category TEXT NOT NULL,
    hour_bucket INTEGER NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    cache_hits INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms INTEGER NOT NULL DEFAULT 0,
    latency_max_ms INTEGER NOT NULL DEFAULT 0,
    status_501 INTEGER NOT NULL DEFAULT 0,
    UNIQUE(endpoint, hour_bucket)
  );
  CREATE INDEX IF NOT EXISTS idx_api_metrics_hour ON api_metrics(hour_bucket DESC);
  CREATE INDEX IF NOT EXISTS idx_api_metrics_endpoint ON api_metrics(endpoint, hour_bucket DESC);
`);

// Prepared once at module load — better-sqlite3 caches the plan and every
// UPSERT below is a single VM roundtrip.
const UPSERT = db.prepare(`
  INSERT INTO api_metrics (endpoint, category, hour_bucket, calls, errors,
                           cache_hits, latency_sum_ms, latency_max_ms, status_501)
  VALUES (@endpoint, @category, @hour_bucket, 1, @error, @cache_hit,
          @latency, @latency, @s501)
  ON CONFLICT(endpoint, hour_bucket) DO UPDATE SET
    calls          = calls          + 1,
    errors         = errors         + @error,
    cache_hits     = cache_hits     + @cache_hit,
    latency_sum_ms = latency_sum_ms + @latency,
    latency_max_ms = MAX(latency_max_ms, @latency),
    status_501     = status_501     + @s501
`);

const HOUR_MS = 60 * 60 * 1000;

// Given a URL like '/api/osint/tool/ipwho/8.8.8.8', return 'osint'.
// Falls back to 'unknown' when we can't parse. First segment after /api/.
function categoryFromUrl(url) {
  try {
    const clean = String(url || '').split('?')[0];
    const parts = clean.split('/').filter(Boolean);
    // Express strips /api before it reaches routes, but Express-5 mounts
    // report the full path via req.originalUrl. Handle both.
    if (parts[0] === 'api') parts.shift();
    return (parts[0] || 'unknown').toLowerCase();
  } catch {
    return 'unknown';
  }
}

// Prefer `req.route.path` (the matched pattern like '/osint/tool/:name')
// so /api/osint/tool/ipwho/8.8.8.8 and .../1.1.1.1 fold onto ONE row.
// Fall back to baseUrl+path for handlers that mount via wildcards.
function endpointFromReq(req) {
  try {
    if (req.route?.path) {
      const base = req.baseUrl || '';
      // req.route.path can be an array in Express 5 (multiple patterns).
      const p = Array.isArray(req.route.path) ? req.route.path[0] : req.route.path;
      return (base + p).replace(/\/+$/, '') || '/';
    }
    // Strip query + strip the /api prefix so category-first parsing lines up.
    const clean = String(req.originalUrl || '').split('?')[0];
    return clean || '/';
  } catch {
    return String(req.originalUrl || '/').split('?')[0];
  }
}

/**
 * Express middleware — attaches a `finish` listener to res that records
 * one metrics row per response. Safe to mount before any body parser (it
 * doesn't touch the body); the brief mounts it AFTER body parsers so
 * request timing includes parse latency, which is what we want.
 */
export function apiMetricsMiddleware(req, res, next) {
  // Only track /api/* — static-file responses and health probes we care
  // about live under /api anyway.
  if (!req.originalUrl?.startsWith('/api/')) return next();

  const start = Date.now();
  res.on('finish', () => {
    try {
      const endpoint = endpointFromReq(req);
      const category = categoryFromUrl(req.originalUrl);
      const latency  = Date.now() - start;
      const status   = res.statusCode || 0;
      const cacheHit = res.getHeader?.('X-Cache-Hit');
      const hourBucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

      UPSERT.run({
        endpoint,
        category,
        hour_bucket: hourBucket,
        error:       status >= 400 ? 1 : 0,
        cache_hit:   String(cacheHit || '') === '1' ? 1 : 0,
        latency:     latency,
        s501:        status === 501 ? 1 : 0,
      });
    } catch (err) {
      // Never surface — this is best-effort telemetry.
      try { logger.warn?.(`apiMetrics record failed: ${err.message}`); } catch {}
    }
  });
  next();
}

// ── Query helpers used by the admin endpoint ────────────────────────

/**
 * Roll up metrics into a per-endpoint summary for the last 24h + 7d.
 * Returns rows sorted by 24h call count descending.
 */
export function summarizeEndpoints({ hours24 = 24, hours7d = 24 * 7 } = {}) {
  const now = Date.now();
  const since24 = Math.floor((now - hours24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const since7d = Math.floor((now - hours7d * HOUR_MS) / HOUR_MS) * HOUR_MS;

  // Latency approximation: avg = sum / calls; "p95" is left as latency_max
  // since we don't store per-request samples. Not a true p95 — we label it
  // maxLatencyMs in the API response so callers aren't misled.
  const rows24 = db.prepare(`
    SELECT endpoint,
           MAX(category)              AS category,
           SUM(calls)                 AS calls_24h,
           SUM(errors)                AS errors_24h,
           SUM(cache_hits)            AS cache_hits_24h,
           SUM(latency_sum_ms)        AS latency_sum_24h,
           MAX(latency_max_ms)        AS latency_max_24h,
           SUM(status_501)            AS status_501_24h,
           MAX(hour_bucket)           AS last_hour_bucket
      FROM api_metrics
     WHERE hour_bucket >= ?
     GROUP BY endpoint
     ORDER BY calls_24h DESC
  `).all(since24);

  const rows7dMap = new Map();
  const rows7dRaw = db.prepare(`
    SELECT endpoint, SUM(calls) AS calls_7d
      FROM api_metrics
     WHERE hour_bucket >= ?
     GROUP BY endpoint
  `).all(since7d);
  for (const r of rows7dRaw) rows7dMap.set(r.endpoint, Number(r.calls_7d || 0));

  return rows24.map(r => {
    const calls   = Number(r.calls_24h || 0);
    const errors  = Number(r.errors_24h || 0);
    const cacheHt = Number(r.cache_hits_24h || 0);
    return {
      endpoint:        r.endpoint,
      category:        r.category,
      calls_24h:       calls,
      calls_7d:        rows7dMap.get(r.endpoint) || 0,
      errors_24h:      errors,
      error_rate:      calls ? +(errors / calls).toFixed(4) : 0,
      cache_hits_24h:  cacheHt,
      cache_hit_rate:  calls ? +(cacheHt / calls).toFixed(4) : 0,
      avg_latency_ms:  calls ? Math.round(Number(r.latency_sum_24h) / calls) : 0,
      max_latency_ms:  Number(r.latency_max_24h || 0),
      status_501_24h:  Number(r.status_501_24h || 0),
      last_hit_at:     r.last_hour_bucket
        ? new Date(Number(r.last_hour_bucket)).toISOString()
        : null,
    };
  });
}

/**
 * Coarse totals for the dashboard header.
 */
export function totalsForWindow(hours = 24) {
  const since = Math.floor((Date.now() - hours * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const row = db.prepare(`
    SELECT COUNT(DISTINCT endpoint) AS endpoints,
           SUM(calls)               AS calls,
           SUM(errors)              AS errors,
           SUM(cache_hits)          AS cache_hits,
           SUM(status_501)          AS status_501
      FROM api_metrics
     WHERE hour_bucket >= ?
  `).get(since) || {};
  const calls  = Number(row.calls || 0);
  const errors = Number(row.errors || 0);
  const cache  = Number(row.cache_hits || 0);
  return {
    endpoints:      Number(row.endpoints || 0),
    calls,
    errors,
    error_rate:     calls ? +(errors / calls).toFixed(4) : 0,
    cache_hits:     cache,
    cache_hit_rate: calls ? +(cache / calls).toFixed(4) : 0,
    status_501:     Number(row.status_501 || 0),
  };
}

/**
 * Per-hour buckets for the trend chart (default: last 24 hours).
 */
export function hourlyBuckets(hours = 24) {
  const since = Math.floor((Date.now() - hours * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const rows = db.prepare(`
    SELECT hour_bucket,
           SUM(calls)      AS calls,
           SUM(errors)     AS errors,
           SUM(cache_hits) AS cache_hits
      FROM api_metrics
     WHERE hour_bucket >= ?
     GROUP BY hour_bucket
     ORDER BY hour_bucket ASC
  `).all(since);
  return rows.map(r => ({
    hour:       new Date(Number(r.hour_bucket)).toISOString(),
    calls:      Number(r.calls || 0),
    errors:     Number(r.errors || 0),
    cache_hits: Number(r.cache_hits || 0),
  }));
}
