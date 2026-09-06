// Pure math module for the compound double pendulum.
//
// Same equations of motion as the FE PhysicsLab (src/pages/PhysicsLab.jsx),
// derived from Euler-Lagrange on the double-pendulum Lagrangian
//   L = K - V
//   K = ½ m₁ L₁² θ̇₁²
//     + ½ m₂ (L₁² θ̇₁² + L₂² θ̇₂² + 2 L₁ L₂ θ̇₁ θ̇₂ cos(θ₁-θ₂))
//   V = -(m₁+m₂) g L₁ cosθ₁ - m₂ g L₂ cosθ₂
//
// Integrated with fourth-order Runge–Kutta (classical RK4). This file is
// intentionally free of Express / logger imports so it can be unit-tested
// as a plain function graph.

// ─── Equations of motion ──────────────────────────────────────────────
// θ̈₁, θ̈₂ from Euler-Lagrange on the double-pendulum Lagrangian.
// State: { t1, t2, w1, w2 }  (θ₁, θ₂, ω₁, ω₂)
// Params: { L1, L2, m1, m2, g }
function accelerations({ t1, t2, w1, w2, m1, m2, L1, L2, g }) {
  const dt = t1 - t2;
  const sinDt = Math.sin(dt);
  const cosDt = Math.cos(dt);
  const denom1 = L1 * (2 * m1 + m2 - m2 * Math.cos(2 * dt));
  const denom2 = L2 * (2 * m1 + m2 - m2 * Math.cos(2 * dt));
  const a1 = (
    -g * (2 * m1 + m2) * Math.sin(t1)
    - m2 * g * Math.sin(t1 - 2 * t2)
    - 2 * sinDt * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * cosDt)
  ) / denom1;
  const a2 = (
    2 * sinDt * (
      w1 * w1 * L1 * (m1 + m2)
      + g * (m1 + m2) * Math.cos(t1)
      + w2 * w2 * L2 * m2 * cosDt
    )
  ) / denom2;
  return { a1, a2 };
}

// ─── State algebra helpers ────────────────────────────────────────────
const add = (a, b) => ({ t1: a.t1 + b.t1, t2: a.t2 + b.t2, w1: a.w1 + b.w1, w2: a.w2 + b.w2 });
const mul = (a, s) => ({ t1: a.t1 * s, t2: a.t2 * s, w1: a.w1 * s, w2: a.w2 * s });

// ─── One RK4 step ─────────────────────────────────────────────────────
// state = {t1, t2, w1, w2}, params = {L1, L2, m1, m2, g}, h = step size (s).
// Returns the new state after advancing time by h.
export function stepRK4(state, params, h) {
  const derive = (s) => {
    const { a1, a2 } = accelerations({ ...s, ...params });
    return { t1: s.w1, t2: s.w2, w1: a1, w2: a2 };
  };
  const k1 = derive(state);
  const k2 = derive(add(state, mul(k1, h / 2)));
  const k3 = derive(add(state, mul(k2, h / 2)));
  const k4 = derive(add(state, mul(k3, h)));
  return add(state, mul(add(add(k1, mul(k2, 2)), add(mul(k3, 2), k4)), h / 6));
}

// ─── Energies ─────────────────────────────────────────────────────────
// Kinetic K, potential V, total E = K + V (in Joules for SI-unit inputs).
export function energies(state, params) {
  const { t1, t2, w1, w2 } = state;
  const { m1, m2, L1, L2, g } = params;
  const K = 0.5 * m1 * L1 * L1 * w1 * w1
    + 0.5 * m2 * (
      L1 * L1 * w1 * w1
      + L2 * L2 * w2 * w2
      + 2 * L1 * L2 * w1 * w2 * Math.cos(t1 - t2)
    );
  const V = -(m1 + m2) * g * L1 * Math.cos(t1) - m2 * g * L2 * Math.cos(t2);
  return { K, V, E: K + V };
}

// ─── Cartesian positions of the two bobs ──────────────────────────────
// Pivot is (0, 0). +x right, +y down (canvas convention). Callers can
// flip y for a physics-y-up plot; the ratio only matters for phase and
// energy is coordinate-invariant.
function positions(state, params) {
  const { t1, t2 } = state;
  const { L1, L2 } = params;
  const x1 = L1 * Math.sin(t1);
  const y1 = L1 * Math.cos(t1);
  const x2 = x1 + L2 * Math.sin(t2);
  const y2 = y1 + L2 * Math.cos(t2);
  return { x1, y1, x2, y2 };
}

// ─── Full-series simulation ───────────────────────────────────────────
// Runs the pendulum for `duration` seconds at fixed step `dt`. Returns
// { series: [{ t, t1, t2, w1, w2, K, V, E, x1, y1, x2, y2 }] }.
// If the raw series would exceed MAX_POINTS samples, we downsample by
// keeping every N-th step so plots stay light. The endpoints of each
// step are always the exact integrated state — no interpolation.
const MAX_POINTS = 4000;

export function simulate(params, initial, { duration = 10, dt = 0.005 } = {}) {
  const steps = Math.max(1, Math.floor(duration / dt));
  const stride = Math.max(1, Math.ceil((steps + 1) / MAX_POINTS));

  let state = { ...initial };
  const series = [];

  const push = (t, s) => {
    const { K, V, E } = energies(s, params);
    const { x1, y1, x2, y2 } = positions(s, params);
    series.push({
      t: Number(t.toFixed(6)),
      t1: s.t1, t2: s.t2, w1: s.w1, w2: s.w2,
      K, V, E,
      x1, y1, x2, y2,
    });
  };

  push(0, state);
  for (let i = 1; i <= steps; i++) {
    state = stepRK4(state, params, dt);
    if (i % stride === 0 || i === steps) {
      push(i * dt, state);
    }
  }
  return { series };
}

// ─── Phase-portrait sweep ─────────────────────────────────────────────
// Takes N initial conditions and returns their θ₁(t) / ω₁(t) arrays so
// the caller can render a phase-space (θ₁, ω₁) plot. Downsampled per
// curve so N × steps doesn't explode the payload.
const MAX_PHASE_POINTS_PER_CURVE = 2000;

export function phasePortrait(params, initials, { duration = 8, dt = 0.008 } = {}) {
  if (!Array.isArray(initials) || initials.length === 0) {
    return { curves: [] };
  }
  const steps = Math.max(1, Math.floor(duration / dt));
  const stride = Math.max(1, Math.ceil((steps + 1) / MAX_PHASE_POINTS_PER_CURVE));

  const curves = initials.map((initial) => {
    let state = { ...initial };
    const t1 = [state.t1];
    const w1 = [state.w1];
    for (let i = 1; i <= steps; i++) {
      state = stepRK4(state, params, dt);
      if (i % stride === 0 || i === steps) {
        t1.push(state.t1);
        w1.push(state.w1);
      }
    }
    return { t1, w1 };
  });

  return { curves };
}
