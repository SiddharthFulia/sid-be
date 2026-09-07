// Context bundler for the System Oracle agent.
//
// Assembles a compact JSON snapshot of the live server so the LLM can answer
// operational questions ("what queues exist", "how many rows in chess_games",
// "which crons are scheduled") without needing tool-calling loops.
//
// EVERY sub-collector is wrapped in try/catch — a missing PM2 binary, a
// broken CloudAMQP mgmt URL, or a table that doesn't exist on this DB file
// must NOT nuke the whole bundle. Failures are recorded as
// `{ error: '<message>' }` on the affected field so the LLM (and the FE
// debug view) can see exactly which subsystem is down.
//
// SECURITY:
//   · Env vars: keys only, never values.
//   · DB tables: schema + aggregate counts only, never row contents.
//   · Routes: paths + methods, never body samples.
//
// Everything here reuses existing services (dbExplorer.listTables,
// managementApi.listAllQueues, getRegisteredCrons) instead of re-implementing.
// The one exception is PM2 introspection — we spawn `pm2 jlist` because we
// don't want a hard dependency on the pm2 npm package, and the CLI is
// guaranteed to be on the deploy box.

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { listTables } from '../../admin/dbExplorer.js';
import { listAllQueues } from '../../rabbitmq/managementApi.js';
import { getRegisteredCrons } from '../../../master_cron_server.js';
import { API_CATALOG, countByCategory } from '../../apiCatalog/index.js';
import { summarizeEndpoints, totalsForWindow } from '../../metrics/apiMetrics.js';

// Groq model catalog — hardcoded because it's part of the Oracle's answers,
// not a live discovery. Update alongside services/groq.js when Groq rotates
// their offering.
const GROQ_MODEL_CATALOG = [
  { id: 'llama-3.1-8b-instant',     tier: 'fast',     provider: 'Groq' },
  { id: 'llama-3.3-70b-versatile',  tier: 'balanced', provider: 'Groq' },
  { id: 'openai/gpt-oss-120b',      tier: 'reasoning', provider: 'Groq' },
];

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT  = path.resolve(path.dirname(__filename), '..', '..', '..');
const ROUTES_DIR = path.join(REPO_ROOT, 'routes');

// ── Public entrypoint ──────────────────────────────────────────
/**
 * Build the full context bundle. Every subsystem is optional — a failure in
 * one field never blocks the others. Returns a plain object safe to
 * JSON.stringify.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeSampleRows=false]  reserved — currently ignored
 * @returns {Promise<object>}
 */
export async function buildSystemContext(opts = {}) {
  const _opts = opts;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Fire the async collectors in parallel — the DB / cron / uptime / env
  // ones are sync and tiny, but pm2 + rabbit take a network hop each.
  const [
    tablesRes,
    queuesRes,
    pm2Res,
    routesRes,
  ] = await Promise.allSettled([
    collectTables(),
    collectQueues(),
    collectPm2Processes(),
    collectRoutes(),
  ]);

  const bundle = {
    assembledAt:   startedAt,
    process:       collectProcessInfo(),
    hostSystem:    collectHostInfo(),
    tables:        settled(tablesRes,  { tables: [], error: 'collector crashed' }),
    queues:        settled(queuesRes,  { queues: [], error: 'collector crashed' }),
    pm2Processes:  settled(pm2Res,     { processes: [], error: 'collector crashed' }),
    crons:         collectCrons(),
    // The routes collector duplicates data we now surface via apiCatalog
    // (with richer metadata). We still expose the raw routes list for
    // debugging via GET /api/agents/system/context, just not to the
    // Oracle prompt — the FE can drop it with a query param if it wants.
    routes:        settled(routesRes,  { routes: [], error: 'collector crashed' }),
    envVarNames:   collectEnvVarNames(),
    groqModels:    GROQ_MODEL_CATALOG,
    apiCatalog:    collectApiCatalog(),
    apiMetrics:    collectApiMetrics(),
  };

  bundle.assembleMs = Date.now() - t0;
  return bundle;
}

function settled(res, fallback) {
  if (res.status === 'fulfilled') return res.value;
  return { ...fallback, error: res.reason?.message || String(res.reason) };
}

// ── Collectors ─────────────────────────────────────────────────

// Uptime + memory of THIS Node process, not the host.
function collectProcessInfo() {
  try {
    const mem = process.memoryUsage();
    return {
      pid:            process.pid,
      uptimeSeconds:  Math.round(process.uptime()),
      nodeVersion:    process.version,
      cwd:            process.cwd(),
      memRssBytes:    mem.rss,
      memHeapUsed:    mem.heapUsed,
      memHeapTotal:   mem.heapTotal,
      memExternal:    mem.external,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Host-level: platform, CPU count, free/total RAM, load avg, OS uptime.
function collectHostInfo() {
  try {
    return {
      platform:      os.platform(),
      arch:          os.arch(),
      hostname:      os.hostname(),
      cpuCount:      os.cpus().length,
      loadAvg:       os.loadavg(),
      totalMemBytes: os.totalmem(),
      freeMemBytes:  os.freemem(),
      osUptimeSec:   Math.round(os.uptime()),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// SQLite tables: name + column count + row count + last updated_at (if the
// table has one). Reuses dbExplorer.listTables() which already caches the
// schema for 30s and enforces the read-only connection.
async function collectTables() {
  try {
    const raw = listTables();
    // Best-effort "last activity" via updatedAt or createdAt column. We open
    // no new DB connection — the readonly one inside dbExplorer already ran
    // the COUNT(*) during listTables(). For the max(updatedAt) column we
    // reach for the ro handle indirectly via dbExplorer's exports; simpler
    // to just import the main db and prepare a MAX() per table here since
    // we want to keep this collector self-contained.
    const { db } = await import('../../aiVideo/db.js');
    const tables = raw.map(t => {
      let lastUpdatedAt = null;
      let updatedCol    = null;
      // Prefer updatedAt, fall back to createdAt. Some tables (e.g. games_scores)
      // only ever grow, so createdAt is the meaningful "last activity".
      for (const candidate of ['updatedAt', 'createdAt', 'completedAt']) {
        if (t.columns.some(c => c.name === candidate)) {
          updatedCol = candidate;
          break;
        }
      }
      if (updatedCol) {
        try {
          const row = db.prepare(
            `SELECT MAX(${quoteIdent(updatedCol)}) AS lastAt FROM ${quoteIdent(t.name)}`,
          ).get();
          lastUpdatedAt = row?.lastAt || null;
        } catch {
          // Column missing on this DB file, or table is a virtual/FTS
          // shadow — skip.
        }
      }
      return {
        name:          t.name,
        rowCount:      t.rowCount,
        columnCount:   t.columns.length,
        columns:       t.columns.map(c => c.name),        // names only, no sample data
        lastActivity:  lastUpdatedAt,
        lastActivityColumn: updatedCol,
      };
    });
    return { tables, count: tables.length };
  } catch (err) {
    return { tables: [], count: 0, error: err.message };
  }
}

// CloudAMQP / LavinMQ queues via the management HTTP API. Reuses the same
// helper the admin dashboard uses so the cache (5s) is shared.
async function collectQueues() {
  try {
    const res = await listAllQueues();
    if (!res.configured) {
      return { queues: [], count: 0, configured: false };
    }
    const queues = (res.queues || []).map(q => ({
      name:          q.name,
      messageCount:  q.messageCount,
      consumerCount: q.consumerCount,
      state:         q.state,
    }));
    return { queues, count: queues.length, configured: true, error: res.error || null };
  } catch (err) {
    return { queues: [], count: 0, error: err.message };
  }
}

// PM2 process list via `pm2 jlist` (JSON output). We spawn the CLI instead
// of importing the pm2 npm package because:
//   1) pm2 isn't in package.json as a dependency, and
//   2) `pm2 jlist` is guaranteed on the deploy box (Oracle) where it's a
//      global install used by ecosystem.config.cjs.
// Returns { processes: [], error?: '...' } — an ENOENT (pm2 not installed
// on dev machine) is reported cleanly, not thrown.
async function collectPm2Processes() {
  try {
    const raw = await runCommand('pm2', ['jlist'], 4000);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { processes: [], count: 0, error: 'pm2 jlist output was not JSON' };
    }
    if (!Array.isArray(parsed)) {
      return { processes: [], count: 0, error: 'pm2 jlist did not return an array' };
    }
    const processes = parsed.map(p => ({
      name:         p.name,
      pid:          p.pid,
      status:       p.pm2_env?.status,
      restartCount: p.pm2_env?.restart_time,
      uptimeMs:     p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
      memBytes:     p.monit?.memory,
      cpuPercent:   p.monit?.cpu,
      execMode:     p.pm2_env?.exec_mode,
      instances:    p.pm2_env?.instances,
    }));
    return { processes, count: processes.length };
  } catch (err) {
    return { processes: [], count: 0, error: err.message };
  }
}

// Cron jobs from the registry populated by startCrons(). Zero cost — the
// registry was already built at boot.
function collectCrons() {
  try {
    const jobs = getRegisteredCrons();
    return { jobs, count: jobs.length };
  } catch (err) {
    return { jobs: [], count: 0, error: err.message };
  }
}

// Mounted routes — walks routes/**/index.js and greps for router.<method>(
// patterns. This is a static-analysis approximation of what express would
// actually serve; the alternative (introspect app._router at request time)
// is fragile in Express 5 which restructured the router internals.
//
// Every path is prefixed with '/api' because routes/index.js mounts under
// '/api' in app.js.
async function collectRoutes() {
  try {
    const routes = [];
    const files = walkJsFiles(ROUTES_DIR);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        // Match `router.get('/path'` | `router.post('/path'` | etc.
        // Ignores middleware-only mounts (router.use).
        const re = /\brouter\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          const method = m[1].toUpperCase();
          let p = m[2];
          if (!p.startsWith('/')) p = '/' + p;
          const fullPath = '/api' + p;
          routes.push({ method, path: fullPath });
        }
      } catch {
        // Unreadable file — skip.
      }
    }
    // De-dupe on (method, path) — keep the first occurrence.
    const seen = new Set();
    const unique = [];
    for (const r of routes) {
      const k = `${r.method} ${r.path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
    }
    unique.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    return { routes: unique, count: unique.length };
  } catch (err) {
    return { routes: [], count: 0, error: err.message };
  }
}

// API catalog — canonical list of every endpoint with upstream + rate
// limit + cache TTL. Fed to the Oracle so it can answer "what's behind
// /osint/wikipedia" without guessing.
//
// SIZE BUDGET: the full catalog (321 entries × ~400B each) blows
// Groq's free-tier 8k TPM input cap. We ship a COMPACT variant:
//   • drop internal / worker callback entries (auth_required==='worker-token')
//     — users never ask about those.
//   • drop bulky/empty fields per row (subcategory when null, upstream when
//     null, etc.). Keep only the fields the Oracle needs to answer:
//     endpoint, method, category, upstream/upstream_name, auth, rate_limit,
//     cache_ttl_sec, tool_name.
// The full-detail form (with params + tags + example_url + description)
// is still available via GET /api/api-catalog.
function collectApiCatalog() {
  try {
    const filtered = API_CATALOG.filter(e => e.auth_required !== 'worker-token');
    const compact = filtered.map(e => {
      const row = {
        endpoint: e.endpoint,
        method:   e.method,
        category: e.category,
      };
      if (e.subcategory)                              row.subcategory   = e.subcategory;
      if (e.upstream)                                 row.upstream      = e.upstream;
      if (e.upstream_name)                            row.upstream_name = e.upstream_name;
      if (e.auth_required && e.auth_required !== false) row.auth_required = e.auth_required;
      if (e.rate_limit)                               row.rate_limit    = e.rate_limit;
      if (Number.isFinite(e.cache_ttl_sec) && e.cache_ttl_sec > 0) row.cache_ttl_sec = e.cache_ttl_sec;
      if (e.tool_name)                                row.tool_name     = e.tool_name;
      return row;
    });
    return {
      entries:         compact,
      count:           compact.length,
      countByCategory: countByCategory(),
      note: 'Compact form. Full catalog with params + tags at GET /api/api-catalog.',
    };
  } catch (err) {
    return { entries: [], count: 0, error: err.message };
  }
}

// Aggregated 24h metrics from api_metrics (populated by the middleware
// in services/metrics/apiMetrics.js). Top-25 endpoints by call count so
// the JSON fits inside Groq's free-tier context ceiling — the FE
// dashboard uses `/api/admin/api-usage` directly for the full list.
function collectApiMetrics() {
  try {
    const endpoints = summarizeEndpoints({ hours24: 24, hours7d: 24 * 7 }).slice(0, 25);
    return {
      window_hours: 24,
      totals:       totalsForWindow(24),
      endpoints,
      count:        endpoints.length,
    };
  } catch (err) {
    return { totals: {}, endpoints: [], count: 0, error: err.message };
  }
}

// Env var NAMES only — VALUES ARE NEVER RETURNED. If we ever expose values
// we've leaked prod secrets to whichever LLM handles the follow-up.
function collectEnvVarNames() {
  try {
    const names = Object.keys(process.env || {}).sort();
    return { names, count: names.length };
  } catch (err) {
    return { names: [], count: 0, error: err.message };
  }
}

// ── Helpers ────────────────────────────────────────────────────

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function walkJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Small child_process wrapper that resolves to stdout, rejects on non-zero
// exit or timeout. Used only for `pm2 jlist`; kept generic so we can shell
// out to `df` / `uptime` later if we need to.
function runCommand(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    // Windows needs shell:true so the .cmd wrapper for pm2 resolves. Linux
    // (Oracle box) works either way. Using shell:true means we accept a
    // small risk if `cmd` were user-supplied — here it's a hardcoded literal
    // so we're fine.
    const child = spawn(cmd, args, { shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || 'no stderr'}`));
      resolve(stdout);
    });
  });
}

// Byte size of the JSON serialization — useful for token-budget decisions.
export function contextBytes(bundle) {
  try {
    return Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Return a slimmed copy of the bundle for the Groq prompt.
 *
 * The FE debug view (`GET /api/agents/system/context`) still gets the
 * full bundle; only the LLM-facing prompt uses this trimmed variant.
 * Trims:
 *   • `routes` — duplicated by `apiCatalog` in richer form
 *   • `envVarNames` — noise; if the Oracle needs env awareness we surface
 *     it as `envVarNamesCount`
 *   • `apiCatalog.entries` — the full compact catalog is ~45KB (~15k Groq
 *     tokens). If a `question` is provided we filter the entries to
 *     those whose endpoint / category / subcategory / upstream / tool_name
 *     match any word in the question (case-insensitive, ≥3 chars). When
 *     no keywords match, we still ship the countByCategory summary so
 *     the Oracle can steer the user toward the right area even without
 *     details. Also caps at 60 entries as a hard budget guard.
 */
export function trimForPrompt(bundle, opts = {}) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const question = String(opts.question || '').toLowerCase();
  const clone = { ...bundle };
  if (clone.routes) delete clone.routes;
  if (clone.envVarNames) {
    clone.envVarNamesCount = clone.envVarNames.count ?? 0;
    delete clone.envVarNames;
  }

  // Subsystem relevance — drop what the question clearly isn't asking
  // about. Groq free tier's 8k input-TPM cap forces us to be picky.
  // Keyword lists are intentionally broad (matches "table" and "tables"
  // and "row" and "rows"). Each dropped block is replaced with a stub
  // `{ available: true }` so the Oracle knows the data exists without
  // paying the token cost.
  const KEYWORDS = {
    tables:       ['table', 'row', 'schema', 'sqlite', 'column', 'database', 'db '],
    queues:       ['queue', 'rabbit', 'amqp', 'lavin', 'consumer'],
    pm2Processes: ['pm2', 'process', 'restart', 'worker', 'daemon'],
    crons:        ['cron', 'schedule', 'nightly', 'monthly'],
    hostSystem:   ['host', 'cpu', 'memory', 'load', 'uptime', 'system', 'ram', 'disk'],
    groqModels:   ['groq', 'model', 'llama', 'gpt'],
    apiMetrics:   ['metric', 'traffic', 'latency', 'error rate', 'p95', 'usage', 'hits', 'call', 'busiest', 'popular', 'most', 'peak'],
  };
  for (const [field, hits] of Object.entries(KEYWORDS)) {
    if (!(field in clone)) continue;
    const wanted = hits.some(w => question.includes(w));
    if (!wanted) {
      // Preserve counts so the Oracle can still cite "X tables exist".
      const stub = { pruned: true };
      if (typeof clone[field]?.count === 'number') stub.count = clone[field].count;
      clone[field] = stub;
    }
  }

  // Tables: even when kept, trim the per-row payload down to essentials.
  if (!clone.tables?.pruned && clone.tables?.tables?.length) {
    clone.tables = {
      ...clone.tables,
      tables: clone.tables.tables.map(t => ({
        name:         t.name,
        rowCount:     t.rowCount,
        columnCount:  t.columnCount,
        lastActivity: t.lastActivity,
      })),
    };
  }
  if (clone.apiCatalog?.entries?.length) {
    const question = String(opts.question || '').toLowerCase();
    const words = Array.from(new Set(
      question.split(/[^a-z0-9\-_]+/i).filter(w => w.length >= 3)
    ));
    const MAX_ENTRIES = 60;
    let entries = clone.apiCatalog.entries;
    if (words.length) {
      const matches = entries.filter(e => {
        const hay = [e.endpoint, e.category, e.subcategory, e.upstream, e.upstream_name, e.tool_name]
          .filter(Boolean).join(' ').toLowerCase();
        return words.some(w => hay.includes(w));
      });
      // If the filter produced anything, use it — else fall back to a
      // small sample so the Oracle still has some catalog visibility.
      if (matches.length) entries = matches;
    }
    if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
    clone.apiCatalog = {
      ...clone.apiCatalog,
      entries,
      filteredFor: words.length ? words : null,
      truncatedAt: MAX_ENTRIES,
      note: 'Filtered to endpoints matching question keywords. Full catalog at GET /api/api-catalog.',
    };
  }
  return clone;
}

export { GROQ_MODEL_CATALOG };
