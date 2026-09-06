// /api/physics/* — server-side physics compute for the double pendulum.
//
// Handlers offload heavy RK4 runs off the FE main thread. Everything is
// stateless, no caching (results are exact-input-dependent — a 1e-9 nudge
// on any param yields a genuinely different chaotic trajectory), and
// public (no auth). Duration + dt are hard-capped so a single request
// can't spin the event loop for minutes.
//
//   POST /api/physics/pendulum/simulate  — { series }
//   POST /api/physics/pendulum/phase     — { curves }
//   POST /api/physics/pendulum/lyapunov  — { lyapunov, series: [{ t, sep }] }

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  stepRK4,
  energies,
  simulate as simulatePendulum,
  phasePortrait,
} from '../../services/physics/doublePendulum.js';

// Hard limits — prevent runaway compute.
const MAX_DURATION       = 60;    // seconds
const MIN_DT             = 0.001; // seconds
const MAX_PHASE_INITIALS = 64;    // curves per phase-portrait request

// ─── Validators ───────────────────────────────────────────────────────
// Params must be finite positive numbers. We coerce to Number and then
// check Number.isFinite so we catch NaN and undefined uniformly.
function validateParams(params) {
  if (!params || typeof params !== 'object') return 'params object is required';
  const keys = ['L1', 'L2', 'm1', 'm2', 'g'];
  for (const k of keys) {
    const v = Number(params[k]);
    if (!Number.isFinite(v)) return `params.${k} must be a finite number`;
    if (v <= 0) return `params.${k} must be > 0`;
  }
  return null;
}

function validateInitial(initial) {
  if (!initial || typeof initial !== 'object') return 'initial object is required';
  const keys = ['t1', 't2', 'w1', 'w2'];
  for (const k of keys) {
    const v = Number(initial[k]);
    if (!Number.isFinite(v)) return `initial.${k} must be a finite number`;
  }
  return null;
}

function normalizeParams(p) {
  return { L1: Number(p.L1), L2: Number(p.L2), m1: Number(p.m1), m2: Number(p.m2), g: Number(p.g) };
}

function normalizeState(s) {
  return { t1: Number(s.t1), t2: Number(s.t2), w1: Number(s.w1), w2: Number(s.w2) };
}

// ─── POST /api/physics/pendulum/simulate ──────────────────────────────
// Body: { params: {L1,L2,m1,m2,g}, initial: {t1,t2,w1,w2},
//         duration=10, dt=0.005 }
// Returns { series: [{t, t1, t2, w1, w2, K, V, E, x1, y1, x2, y2}] }.
// The service downsamples the series if it would exceed 4000 points.
export const postSimulate = async (req, res) => {
  const started = Date.now();
  try {
    const { params, initial } = req.body || {};
    const duration = Number(req.body?.duration ?? 10);
    const dt       = Number(req.body?.dt ?? 0.005);

    const pErr = validateParams(params);   if (pErr) return error(res, pErr, 400);
    const iErr = validateInitial(initial); if (iErr) return error(res, iErr, 400);
    if (!Number.isFinite(duration) || duration <= 0) return error(res, 'duration must be > 0', 400);
    if (!Number.isFinite(dt) || dt <= 0)             return error(res, 'dt must be > 0',       400);
    if (duration > MAX_DURATION) return error(res, `duration must be <= ${MAX_DURATION}s`, 400);
    if (dt < MIN_DT)             return error(res, `dt must be >= ${MIN_DT}s`,             400);

    const out = simulatePendulum(
      normalizeParams(params),
      normalizeState(initial),
      { duration, dt },
    );
    logger.info(
      `physics.simulate points=${out.series.length} dur=${duration}s dt=${dt}s took ${Date.now() - started}ms`,
    );
    return success(res, { ...out, duration, dt });
  } catch (err) {
    logger.error('physics.simulate failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── POST /api/physics/pendulum/phase ─────────────────────────────────
// Body: { params, initials: [{t1,t2,w1,w2}, ...], duration=8, dt=0.008 }
// Returns { curves: [{t1: [...], w1: [...]}] } for a phase-space plot.
export const postPhase = async (req, res) => {
  const started = Date.now();
  try {
    const { params, initials } = req.body || {};
    const duration = Number(req.body?.duration ?? 8);
    const dt       = Number(req.body?.dt ?? 0.008);

    const pErr = validateParams(params); if (pErr) return error(res, pErr, 400);
    if (!Array.isArray(initials) || initials.length === 0) {
      return error(res, 'initials must be a non-empty array', 400);
    }
    if (initials.length > MAX_PHASE_INITIALS) {
      return error(res, `initials.length must be <= ${MAX_PHASE_INITIALS}`, 400);
    }
    for (let i = 0; i < initials.length; i++) {
      const iErr = validateInitial(initials[i]);
      if (iErr) return error(res, `initials[${i}]: ${iErr}`, 400);
    }
    if (!Number.isFinite(duration) || duration <= 0) return error(res, 'duration must be > 0', 400);
    if (!Number.isFinite(dt) || dt <= 0)             return error(res, 'dt must be > 0',       400);
    if (duration > MAX_DURATION) return error(res, `duration must be <= ${MAX_DURATION}s`, 400);
    if (dt < MIN_DT)             return error(res, `dt must be >= ${MIN_DT}s`,             400);

    const out = phasePortrait(
      normalizeParams(params),
      initials.map(normalizeState),
      { duration, dt },
    );
    logger.info(
      `physics.phase curves=${out.curves.length} dur=${duration}s dt=${dt}s took ${Date.now() - started}ms`,
    );
    return success(res, { ...out, duration, dt });
  } catch (err) {
    logger.error('physics.phase failed', err.message);
    return error(res, err.message, 500);
  }
};

// ─── POST /api/physics/pendulum/lyapunov ──────────────────────────────
// Rough finite-time Lyapunov exponent. Run two trajectories from initial
// conditions x and x+ε (perturbation applied to θ₁ by convention), log
// the euclidean separation ||δ(t)|| in phase-space, and fit
//   λ ≈ (1/T) · ln(||δ(T)|| / ||δ(0)||)
// using the endpoint separation. This is a rough estimate — a proper
// FTLE needs periodic re-normalization; the endpoint form is what the
// FE actually wants to plot as a "chaos strength" scalar.
//
// Body: { params, initial, duration=10, dt=0.005, epsilon=1e-6 }
// Returns { lyapunov, series: [{t, sep}] }.
export const postLyapunov = async (req, res) => {
  const started = Date.now();
  try {
    const { params, initial } = req.body || {};
    const duration = Number(req.body?.duration ?? 10);
    const dt       = Number(req.body?.dt ?? 0.005);
    const epsilon  = Number(req.body?.epsilon ?? 1e-6);

    const pErr = validateParams(params);   if (pErr) return error(res, pErr, 400);
    const iErr = validateInitial(initial); if (iErr) return error(res, iErr, 400);
    if (!Number.isFinite(duration) || duration <= 0) return error(res, 'duration must be > 0', 400);
    if (!Number.isFinite(dt) || dt <= 0)             return error(res, 'dt must be > 0',       400);
    if (!Number.isFinite(epsilon) || epsilon <= 0)   return error(res, 'epsilon must be > 0',  400);
    if (duration > MAX_DURATION) return error(res, `duration must be <= ${MAX_DURATION}s`, 400);
    if (dt < MIN_DT)             return error(res, `dt must be >= ${MIN_DT}s`,             400);

    const P = normalizeParams(params);
    const s0 = normalizeState(initial);

    // Reference trajectory + perturbed trajectory (θ₁ nudged by ε).
    let a = { ...s0 };
    let b = { ...s0, t1: s0.t1 + epsilon };

    const sep0 = Math.hypot(a.t1 - b.t1, a.t2 - b.t2, a.w1 - b.w1, a.w2 - b.w2);
    if (!(sep0 > 0)) return error(res, 'initial separation is zero (epsilon too small)', 400);

    const steps = Math.max(1, Math.floor(duration / dt));
    // Downsample the {t, sep} series to <= 2000 points to match the FE
    // plot budget without dropping the endpoint (needed for λ).
    const MAX_POINTS = 2000;
    const stride = Math.max(1, Math.ceil((steps + 1) / MAX_POINTS));

    const series = [{ t: 0, sep: sep0 }];
    let sepEnd = sep0;
    for (let i = 1; i <= steps; i++) {
      a = stepRK4(a, P, dt);
      b = stepRK4(b, P, dt);
      const s = Math.hypot(a.t1 - b.t1, a.t2 - b.t2, a.w1 - b.w1, a.w2 - b.w2);
      sepEnd = s;
      if (i % stride === 0 || i === steps) {
        series.push({ t: Number((i * dt).toFixed(6)), sep: s });
      }
    }

    // Endpoint estimate. If separations went to zero (numerical underflow)
    // or NaN, report null instead of ±Infinity.
    let lyapunov = null;
    if (Number.isFinite(sepEnd) && sepEnd > 0 && sep0 > 0) {
      lyapunov = Math.log(sepEnd / sep0) / duration;
      if (!Number.isFinite(lyapunov)) lyapunov = null;
    }

    logger.info(
      `physics.lyapunov lambda=${lyapunov} dur=${duration}s dt=${dt}s eps=${epsilon} took ${Date.now() - started}ms`,
    );
    return success(res, { lyapunov, series, duration, dt, epsilon });
  } catch (err) {
    logger.error('physics.lyapunov failed', err.message);
    return error(res, err.message, 500);
  }
};

// Re-export the pure functions for parity with other controller modules
// (chess, agents) that surface their service math.
export { stepRK4, energies };
