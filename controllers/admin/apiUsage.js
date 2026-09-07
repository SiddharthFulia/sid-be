// GET /api/admin/api-usage — vault-gated aggregated metrics endpoint.
//
// Reads from the `api_metrics` table (populated by services/metrics/apiMetrics.js)
// and returns per-endpoint 24h+7d rollups plus hourly buckets for the trend chart.
//
// Query params:
//   ?hours=24         window for the per-endpoint summary (default 24)
//   ?buckets=24       hours of trend data to return (default 24)
//   ?category=osint   optional filter — only endpoints in this category
//   ?minCalls=1       drop endpoints below this call count in the summary

import { summarizeEndpoints, totalsForWindow, hourlyBuckets } from '../../services/metrics/apiMetrics.js';
import { API_CATALOG } from '../../services/apiCatalog/index.js';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';

// Small lookup so we can annotate each row with catalog metadata (upstream,
// rate limit, cache TTL) without duplicating them into the metrics table.
const CATALOG_BY_ENDPOINT = new Map();
for (const entry of API_CATALOG) {
  const list = CATALOG_BY_ENDPOINT.get(entry.endpoint) || [];
  list.push(entry);
  CATALOG_BY_ENDPOINT.set(entry.endpoint, list);
}

function annotate(row) {
  const candidates = CATALOG_BY_ENDPOINT.get(row.endpoint) || [];
  // If more than one entry (same endpoint, different METHOD), take the
  // first — the metrics table doesn't yet track method separately.
  const meta = candidates[0];
  if (!meta) return row;
  return {
    ...row,
    upstream:      meta.upstream || null,
    upstream_name: meta.upstream_name || null,
    rate_limit:    meta.rate_limit || null,
    cache_ttl_sec: meta.cache_ttl_sec ?? null,
    auth_required: meta.auth_required ?? false,
    description:   meta.description || null,
    tags:          meta.tags || [],
  };
}

export async function getApiUsage(req, res) {
  try {
    const hours = clamp(parseInt(req.query.hours, 10) || 24, 1, 24 * 30);
    const bucketHours = clamp(parseInt(req.query.buckets, 10) || 24, 1, 24 * 30);
    const category = String(req.query.category || '').trim().toLowerCase();
    const minCalls = clamp(parseInt(req.query.minCalls, 10) || 0, 0, 1_000_000);

    let summary = summarizeEndpoints({ hours24: hours, hours7d: 24 * 7 });
    if (category) summary = summary.filter(r => r.category === category);
    if (minCalls) summary = summary.filter(r => r.calls_24h >= minCalls);
    summary = summary.map(annotate);

    return success(res, {
      window_hours: hours,
      totals:       totalsForWindow(hours),
      endpoints:    summary,
      buckets:      hourlyBuckets(bucketHours),
    });
  } catch (err) {
    logger.error('admin getApiUsage failed', err.message);
    return error(res, err.message, 500);
  }
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}
