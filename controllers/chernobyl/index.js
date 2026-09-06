// /api/chernobyl/* — RBMK-1000 reactor point-kinetics simulator.
//
// Wraps services/physics/reactor.js — all the ODE work lives there so this
// file is just validation, scenario glue, and a small in-memory cache for
// repeat demo runs.
//
// Endpoints:
//   POST /api/chernobyl/simulate          — arbitrary scenario / custom controls
//   POST /api/chernobyl/scenario/az5      — the 1986 Chernobyl preset (turnkey)
//   GET  /api/chernobyl/scenarios         — list preset scenarios + descriptions
//
// Notes on limits: duration ≤ 300 s and dt ≥ 0.001 s — enough for the AZ-5
// event (which unfolds in seconds) and for xenon transients to *start*
// showing, without letting a single request pin the event loop for minutes.
// A real iodine pit takes ~10 h; we can't run that here without going async
// with a worker queue, and this endpoint isn't the right shape for it.

import crypto from 'crypto';

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { simulate, SCENARIOS, CONSTANTS } from '../../services/physics/reactor.js';

// ─── Hard limits ──────────────────────────────────────────────────────
const MAX_DURATION       = 300;    // s
const MIN_DT             = 0.001;  // s
const MAX_DT             = 1;      // s
const MAX_CONTROL_EVENTS = 200;
const VALID_ACTIONS      = new Set(['rod', 'scram', 'flow']);
const VALID_SCENARIOS    = new Set(SCENARIOS.map((s) => s.id).concat(['custom']));

// ─── Cache ────────────────────────────────────────────────────────────
// Small in-memory LRU-ish cache keyed by scenario+params hash. Repeated
// demo runs (same body twice in a row while the FE is rendering) hit here
// and skip the RK4 loop. 5-minute TTL, capped at 32 entries.
const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX    = 32;

function cacheKey(body) {
  const s = JSON.stringify(body || {});
  return crypto.createHash('sha1').update(s).digest('hex');
}

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return hit.v;
}

function cachePut(key, v) {
  if (CACHE.size >= CACHE_MAX) {
    // Delete the oldest — Map preserves insertion order.
    const first = CACHE.keys().next().value;
    if (first) CACHE.delete(first);
  }
  CACHE.set(key, { t: Date.now(), v });
}

// ─── Validators ───────────────────────────────────────────────────────
function validateControl(control) {
  if (control == null) return null;
  if (!Array.isArray(control)) return 'control must be an array';
  if (control.length > MAX_CONTROL_EVENTS) {
    return `control has ${control.length} events (max ${MAX_CONTROL_EVENTS})`;
  }
  for (let i = 0; i < control.length; i++) {
    const c = control[i];
    if (!c || typeof c !== 'object') return `control[${i}] must be an object`;
    const t = Number(c.t);
    if (!Number.isFinite(t) || t < 0) return `control[${i}].t must be a finite number ≥ 0`;
    if (!VALID_ACTIONS.has(c.action)) {
      return `control[${i}].action must be one of ${[...VALID_ACTIONS].join(', ')}`;
    }
    if (c.action !== 'scram') {
      const v = Number(c.value);
      if (!Number.isFinite(v)) return `control[${i}].value must be a finite number`;
    }
  }
  return null;
}

function validateInitial(initial) {
  if (initial == null) return null;
  if (typeof initial !== 'object') return 'initial must be an object';
  const keys = ['n', 'rod', 'Tf', 'Tc', 'Xe', 'I'];
  for (const k of keys) {
    if (initial[k] === undefined) continue;
    const v = Number(initial[k]);
    if (!Number.isFinite(v)) return `initial.${k} must be a finite number`;
  }
  if (initial.rod !== undefined) {
    const r = Number(initial.rod);
    if (r < 0 || r > 1) return 'initial.rod must be in [0, 1]';
  }
  if (initial.n !== undefined) {
    const n = Number(initial.n);
    if (n < 0) return 'initial.n must be ≥ 0';
  }
  return null;
}

// ─── POST /api/chernobyl/simulate ─────────────────────────────────────
// Body: { scenario, duration, dt, control?, initial? }
//   scenario: 'nominal' | 'az5-scram' | 'xenon-transient'
//           | 'controlled-shutdown' | 'custom'
//   duration: seconds (default 60, max 300)
//   dt:       seconds (default 0.05, min 0.001, max 1)
//   control:  optional array of timed actions (see reactor.js)
//   initial:  optional partial initial state override
//
// Preset scenarios prefill initial+control from SCENARIOS[]; any body
// fields (duration, dt, control, initial) override them.
export const postSimulate = async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const scenario = String(body.scenario ?? 'custom');
    if (!VALID_SCENARIOS.has(scenario)) {
      return error(res, `scenario must be one of ${[...VALID_SCENARIOS].join(', ')}`, 400);
    }

    // Base config from preset (if any).
    const preset = SCENARIOS.find((s) => s.id === scenario);
    const base = preset ? preset.build() : { initial: {}, duration: 60, dt: 0.05, control: [] };

    // Overlay body overrides.
    const duration = Number(body.duration ?? base.duration);
    const dt       = Number(body.dt       ?? base.dt);
    const control  = body.control ?? base.control;
    const initial  = body.initial ? { ...base.initial, ...body.initial } : base.initial;

    if (!Number.isFinite(duration) || duration <= 0) return error(res, 'duration must be > 0', 400);
    if (!Number.isFinite(dt)       || dt <= 0)       return error(res, 'dt must be > 0',       400);
    if (duration > MAX_DURATION) return error(res, `duration must be ≤ ${MAX_DURATION} s`, 400);
    if (dt < MIN_DT)             return error(res, `dt must be ≥ ${MIN_DT} s`,             400);
    if (dt > MAX_DT)             return error(res, `dt must be ≤ ${MAX_DT} s`,             400);

    const cErr = validateControl(control); if (cErr) return error(res, cErr, 400);
    const iErr = validateInitial(initial); if (iErr) return error(res, iErr, 400);

    // Cache check — same scenario+params → same deterministic output.
    const key = cacheKey({ scenario, duration, dt, control, initial });
    const cached = cacheGet(key);
    if (cached) {
      logger.info(`chernobyl.simulate CACHE HIT scenario=${scenario}`);
      return success(res, { ...cached, cached: true });
    }

    const out = simulate({ initial, duration, dt, control });
    cachePut(key, out);

    logger.info(
      `chernobyl.simulate scenario=${scenario} points=${out.series.length} `
      + `events=${out.events.length} verdict=${out.verdict} `
      + `dur=${duration}s dt=${dt}s took ${Date.now() - started}ms`,
    );

    return success(res, {
      scenario,
      duration,
      dt,
      ...out,
      constants: {
        beta:         CONSTANTS.BETA_TOTAL,
        Lambda:       CONSTANTS.LAMBDA,
        P_nominal_MW: CONSTANTS.P_NOMINAL_MW,
        alpha_void:   CONSTANTS.ALPHA_VOID,
        alpha_D:      CONSTANTS.ALPHA_D,
      },
      cached: false,
    });
  } catch (err) {
    logger.error('chernobyl.simulate failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── POST /api/chernobyl/scenario/az5 ─────────────────────────────────
// Turnkey Chernobyl-1986 preset — no body needed. Same shape as simulate.
// Provided as a convenience for the demo landing page so the FE can just
// POST /az5 with no body and get the accident.
export const postAz5 = async (req, res) => {
  const started = Date.now();
  try {
    const preset = SCENARIOS.find((s) => s.id === 'az5-scram');
    if (!preset) return error(res, 'az5-scram preset not found', 500);
    const { initial, duration, dt, control } = preset.build();

    const key = cacheKey({ scenario: 'az5-scram', duration, dt, control, initial });
    const cached = cacheGet(key);
    if (cached) {
      logger.info('chernobyl.az5 CACHE HIT');
      return success(res, {
        scenario: 'az5-scram',
        title: preset.title,
        description: preset.description,
        expected: preset.expected,
        duration, dt,
        ...cached,
        cached: true,
      });
    }

    const out = simulate({ initial, duration, dt, control });
    cachePut(key, out);

    logger.info(
      `chernobyl.az5 points=${out.series.length} events=${out.events.length} `
      + `verdict=${out.verdict} took ${Date.now() - started}ms`,
    );

    return success(res, {
      scenario: 'az5-scram',
      title: preset.title,
      description: preset.description,
      expected: preset.expected,
      duration, dt,
      ...out,
      cached: false,
    });
  } catch (err) {
    logger.error('chernobyl.az5 failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── GET /api/chernobyl/scenarios ─────────────────────────────────────
// Public catalogue — FE renders these as buttons on the reactor viz page.
export const getScenarios = async (req, res) => {
  try {
    const list = SCENARIOS.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      expected: s.expected,
    }));
    return success(res, {
      scenarios: list,
      constants: {
        beta_total:   CONSTANTS.BETA_TOTAL,
        Lambda:       CONSTANTS.LAMBDA,
        alpha_void:   CONSTANTS.ALPHA_VOID,
        alpha_D:      CONSTANTS.ALPHA_D,
        P_nominal_MW: CONSTANTS.P_NOMINAL_MW,
        gamma_I:      CONSTANTS.GAMMA_I,
        gamma_Xe:     CONSTANTS.GAMMA_XE,
        lambda_I:     CONSTANTS.LAMBDA_I,
        lambda_Xe:    CONSTANTS.LAMBDA_XE,
      },
    });
  } catch (err) {
    logger.error('chernobyl.scenarios failed', err.message);
    return error(res, err.message, 500);
  }
};
