// scripts/test-chernobyl-endpoints.mjs — full smoke test of every
// /api/chernobyl/* endpoint against every scenario × parameter combo.
//
// Usage:
//   node scripts/test-chernobyl-endpoints.mjs [--base <url>]
//   BASE=https://api.siddharthfulia.com node scripts/test-chernobyl-endpoints.mjs
//
// Defaults to http://localhost:4001. Prints a pass/fail per combination and
// exits non-zero if any test fails.

import 'dotenv/config';

// ─── Config ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const baseFromFlag = (() => {
  const i = argv.indexOf('--base');
  return i >= 0 ? argv[i + 1] : null;
})();
const BASE = baseFromFlag
  || process.env.BASE
  || process.env.VITE_BE_URL
  || 'http://localhost:4001';

// Colour helpers (no chalk dep).
const c = {
  green : (s) => `\x1b[32m${s}\x1b[0m`,
  red   : (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan  : (s) => `\x1b[36m${s}\x1b[0m`,
  dim   : (s) => `\x1b[2m${s}\x1b[0m`,
  bold  : (s) => `\x1b[1m${s}\x1b[0m`,
};

const SCENARIOS = [
  'nominal',
  'xenon-transient',
  'az5-scram',
  'controlled-shutdown',
  'custom',
];

// Full parameter matrix from the ticket.
const ROD_VALUES     = [0, 50, 100];       // rod position %
const FLOW_VALUES    = [2000, 8000, 12000];// kg/s
const POWER_VALUES   = [0, 2000, 4000];    // MW set
const XENON_VALUES   = [0.2, 1.0, 4.0];    // × equilibrium
const DURATION_VALUES = [10, 60, 120];     // seconds (all ≤ 300 BE cap)
const DT_VALUES      = [0.01, 0.05, 0.2];  // seconds (all in [0.001, 1])

// ─── HTTP helper ──────────────────────────────────────────────────
async function post(path, body) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const ms = Date.now() - started;
  let json = null;
  try { json = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ms, body: json };
}

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`);
  const ms = Date.now() - started;
  let json = null;
  try { json = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ms, body: json };
}

// ─── Test runner ──────────────────────────────────────────────────
const results = { pass: 0, fail: 0, failures: [] };

function record(name, ok, details) {
  if (ok) {
    results.pass++;
    process.stdout.write(c.green('.'));
  } else {
    results.fail++;
    results.failures.push({ name, ...details });
    process.stdout.write(c.red('F'));
  }
}

// ─── 1. GET /api/chernobyl/scenarios ──────────────────────────────
async function testScenariosCatalog() {
  console.log(c.cyan('\n[1/3] GET /api/chernobyl/scenarios'));
  const r = await get('/api/chernobyl/scenarios');
  const ok = r.ok
    && r.body?.status === true
    && Array.isArray(r.body?.data?.scenarios)
    && r.body.data.scenarios.length >= 4;
  record('GET /scenarios', ok, {
    status: r.status,
    scenariosCount: r.body?.data?.scenarios?.length,
    body: ok ? undefined : r.body,
  });
  if (ok) {
    const ids = r.body.data.scenarios.map((s) => s.id);
    console.log(c.dim(`\n     Catalog ids: ${ids.join(', ')} (${r.ms}ms)`));
    // Verify every ID is in our known SCENARIOS list (except 'custom' which isn't in catalog).
    const missing = ids.filter((id) => !SCENARIOS.includes(id));
    if (missing.length) {
      console.log(c.yellow(`     WARN: catalog has unknown ids: ${missing.join(', ')}`));
    }
    const notCatalogued = SCENARIOS.filter((id) => id !== 'custom' && !ids.includes(id));
    if (notCatalogued.length) {
      console.log(c.yellow(`     WARN: test scenarios not in catalog: ${notCatalogued.join(', ')}`));
    }
  } else {
    console.log(c.red(`\n     status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 200)}`));
  }
}

// ─── 2. POST /api/chernobyl/scenario/az5 ──────────────────────────
async function testAz5Preset() {
  console.log(c.cyan('\n[2/3] POST /api/chernobyl/scenario/az5'));
  const r = await post('/api/chernobyl/scenario/az5', {});
  const ok = r.ok
    && r.body?.status === true
    && r.body?.data?.scenario === 'az5-scram'
    && Array.isArray(r.body?.data?.series)
    && r.body.data.series.length > 0
    && Array.isArray(r.body?.data?.events);
  record('POST /scenario/az5', ok, {
    status: r.status,
    verdict: r.body?.data?.verdict,
    seriesLen: r.body?.data?.series?.length,
    body: ok ? undefined : r.body,
  });
  console.log(c.dim(`\n     verdict=${r.body?.data?.verdict} series=${r.body?.data?.series?.length}pts events=${r.body?.data?.events?.length} (${r.ms}ms)`));
}

// ─── 3. POST /api/chernobyl/simulate — parameter matrix ───────────
async function testSimulateMatrix() {
  const fast = argv.includes('--fast');
  console.log(c.cyan(`\n[3/3] POST /api/chernobyl/simulate — ${fast ? 'sampled' : 'full'} matrix`));

  // Build the task list. Two modes:
  //   full  — Cartesian product (3645 combos) — thorough but slow (~1 hr on
  //           the Oracle ARM box because RK4 runs are compute-bound and the
  //           BE cache doesn't help when every combo is unique).
  //   fast  — every scenario × each parameter axis swept independently
  //           against a middle value on the others (5 × (3+3+3+3+3+3) = 90
  //           combos) + all-axes-mid + all-axes-min + all-axes-max per
  //           scenario. Covers every enum × every value on every axis
  //           without the combinatorial blowup.
  const tasks = [];
  if (fast) {
    // Middle values per axis (canonical "nominal" op point).
    const mid = { rod: 50, flow: 8000, powerSet: 2000, xenon: 1.0, duration: 60, dt: 0.05 };
    for (const scenario of SCENARIOS) {
      // One task per (axis, value) with everything else at mid.
      for (const rod of ROD_VALUES)      tasks.push({ scenario, ...mid, rod });
      for (const flow of FLOW_VALUES)    tasks.push({ scenario, ...mid, flow });
      for (const powerSet of POWER_VALUES) tasks.push({ scenario, ...mid, powerSet });
      for (const xenon of XENON_VALUES)  tasks.push({ scenario, ...mid, xenon });
      for (const duration of DURATION_VALUES) tasks.push({ scenario, ...mid, duration });
      for (const dt of DT_VALUES)        tasks.push({ scenario, ...mid, dt });
      // All-min + all-max corners of the parameter cube.
      tasks.push({ scenario, rod: 0,   flow: 2000,  powerSet: 0,    xenon: 0.2, duration: 10,  dt: 0.01 });
      tasks.push({ scenario, rod: 100, flow: 12000, powerSet: 4000, xenon: 4.0, duration: 120, dt: 0.2  });
    }
  } else {
    console.log(c.dim(`     scenarios=${SCENARIOS.length} × rod=${ROD_VALUES.length} × flow=${FLOW_VALUES.length}`));
    console.log(c.dim(`     × power=${POWER_VALUES.length} × xenon=${XENON_VALUES.length} × dur=${DURATION_VALUES.length} × dt=${DT_VALUES.length}`));
    for (const scenario of SCENARIOS)
      for (const rod of ROD_VALUES)
        for (const flow of FLOW_VALUES)
          for (const powerSet of POWER_VALUES)
            for (const xenon of XENON_VALUES)
              for (const duration of DURATION_VALUES)
                for (const dt of DT_VALUES)
                  tasks.push({ scenario, rod, flow, powerSet, xenon, duration, dt });
  }
  console.log(c.dim(`     = ${tasks.length} combinations\n`));

  const CONCURRENCY = Number(process.env.CONCURRENCY) || 8;
  let cursor = 0;
  let printed = 0;
  const runNext = async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      const body = {
        scenario: t.scenario,
        duration: t.duration,
        dt: t.dt,
        // The BE reads sliders via `initial` — pass them through so the
        // test covers the full accepted shape.
        initial: {
          n: Math.max(0, t.powerSet / 3200),
          rod: t.rod / 100,
          Xe: t.xenon * 100,
        },
      };
      const r = await post('/api/chernobyl/simulate', body);
      const ok = r.ok
        && r.body?.status === true
        && Array.isArray(r.body?.data?.series)
        && r.body.data.series.length > 0;
      record(
        `simulate ${t.scenario} rod=${t.rod} flow=${t.flow} P=${t.powerSet} Xe=${t.xenon} dur=${t.duration} dt=${t.dt}`,
        ok,
        {
          status: r.status,
          errMsg: r.body?.message,
          ...t,
        },
      );
      printed++;
      if (printed % 80 === 0) process.stdout.write('\n');
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => runNext()));
  console.log(); // final newline
}

// ─── Main ─────────────────────────────────────────────────────────
(async () => {
  console.log(c.bold(`\nChernobyl endpoint smoke test — base: ${BASE}\n`));
  const started = Date.now();

  try {
    await testScenariosCatalog();
    await testAz5Preset();
    await testSimulateMatrix();
  } catch (e) {
    console.error(c.red(`\nFATAL: ${e.message}`));
    console.error(e.stack);
    process.exit(2);
  }

  const totalMs = Date.now() - started;
  const total = results.pass + results.fail;

  console.log(c.bold(`\n──────── RESULTS ────────`));
  console.log(`Pass:   ${c.green(results.pass)} / ${total}`);
  console.log(`Fail:   ${results.fail ? c.red(results.fail) : results.fail} / ${total}`);
  console.log(`Time:   ${(totalMs / 1000).toFixed(1)}s`);

  if (results.failures.length) {
    console.log(c.red('\nFailures:'));
    // Group failures by error message for readability.
    const byErr = new Map();
    for (const f of results.failures) {
      const key = `${f.status} — ${f.errMsg || '(no message)'}`;
      if (!byErr.has(key)) byErr.set(key, []);
      byErr.get(key).push(f);
    }
    for (const [key, fs] of byErr) {
      console.log(c.red(`\n  ${key}  (${fs.length} case${fs.length === 1 ? '' : 's'})`));
      for (const f of fs.slice(0, 3)) {
        console.log(c.dim(`    • ${f.name}`));
      }
      if (fs.length > 3) console.log(c.dim(`    … and ${fs.length - 3} more`));
    }
  }

  process.exit(results.fail === 0 ? 0 : 1);
})();
