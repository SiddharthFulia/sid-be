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
export async function buildSystemContext(_opts = {}) {
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
    routes:        settled(routesRes,  { routes: [], error: 'collector crashed' }),
    envVarNames:   collectEnvVarNames(),
    groqModels:    GROQ_MODEL_CATALOG,
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
          routes.push({ method, path: fullPath, file: path.relative(REPO_ROOT, file).replace(/\\/g, '/') });
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

export { GROQ_MODEL_CATALOG };
