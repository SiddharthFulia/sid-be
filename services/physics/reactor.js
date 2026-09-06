// Pure math for a lumped-parameter RBMK-1000 reactor simulator.
//
// Physics stack (all in one right-hand side, integrated with RK4):
//   1. Point-kinetics with 6 delayed-neutron precursor groups (Keepin U-235).
//        dn/dt      = ((ρ - β) / Λ) n + Σ λ_i C_i
//        dC_i/dt    = (β_i / Λ) n - λ_i C_i
//   2. Iodine-135 / Xenon-135 Bateman chain (poisoning).
//   3. Fuel + coolant lumped thermal ODEs with saturation-driven void.
//   4. Reactivity balance:  ρ = ρ_rod + ρ_void + ρ_doppler + ρ_xenon.
//
// Everything is dimensionless-ish where it makes the math cleaner:
//   n           — neutron population, normalized to n=1 == nominal full power
//   C_i         — precursor pops normalized to their equilibrium at n=1
//   Xe, I       — /cm³, but tracked relative to equilibrium via σ_Xe φ term
//   ρ           — reactivity (dimensionless), also reported in $ (ρ/β) and pcm
//
// The RBMK-specific twist is in `rodReactivity(...)`: when rods enter from a
// nearly-full-out position, the 1.25 m graphite tip on the bottom of every
// rod *displaces water first* — briefly increasing local reactivity before
// the boron absorber section arrives. This is the "positive scram effect"
// (aka graphite-tip anomaly) that killed Unit 4 in 1986. We model it as a
// bump on ρ_rod that peaks a few seconds into an insertion from > ~90% out.
//
// No Express / logger imports here — this file must stay unit-testable.

// ─── Physics constants ────────────────────────────────────────────────
// U-235 thermal fission, six-group Keepin values. λ in 1/s, a is the
// group's *share* of total delayed emitters (Σ a_i = 1). β_i = β · a_i.
const BETA_TOTAL = 0.0065;                       // total delayed fraction
const KEEPIN_LAMBDA = [0.0127, 0.0317, 0.115, 0.311, 1.40, 3.87]; // 1/s
const KEEPIN_A      = [0.038,  0.213,  0.188, 0.407, 0.128, 0.026];
const BETA_I = KEEPIN_A.map((a) => a * BETA_TOTAL);

const LAMBDA = 1e-4;                             // prompt neutron lifetime Λ (s)

// Xe-135 / I-135 chain. Yields per fission (thermal U-235), decay constants,
// and the σ_Xe φ absorption term. We scale things so that at n=1 the xenon
// reactivity worth at equilibrium is ~ -5000 pcm (the -0.05 target).
const GAMMA_I  = 0.0639;                         // I-135 fission yield
const GAMMA_XE = 0.00237;                        // Xe-135 direct fission yield
const LAMBDA_I  = 2.87e-5;                       // 1/s  (T½ ≈ 6.7 h)
const LAMBDA_XE = 2.11e-5;                       // 1/s  (T½ ≈ 9.1 h)

// Chernobyl-relevant reactivity coefficients.
// Void: RBMK is famously positive, ≈ +4 β at full power.
const ALPHA_VOID = 4.0 * BETA_TOTAL;             // Δρ per unit void fraction
const VOID_REF   = 0.0;
// Doppler: fuel-temperature broadening of U-238 resonances. Always negative.
const ALPHA_D    = -2.5e-5;                      // Δρ per K  (-2.5 pcm/K)
const T_FUEL_REF = 600;                          // K, hot-zero-power fuel temp

// Xenon reactivity scaling — normalize so full equilibrium Xe at n=1
// yields ρ_xenon ≈ -0.05 (5000 pcm). Derived from steady state:
//    Xe_eq = (γ_I + γ_Xe) Σ_f φ / (λ_Xe + σ_Xe φ)
// We fold the Σ_f φ / normalization into a single dimensionless SIGMA_XE_N
// against a reference n=1 population.
// Xenon equilibrium reactivity worth. Textbooks quote -2600 to -5000 pcm
// depending on power level and fuel history. RBMK at full power sat closer
// to the low end because operators compensated with rod position; we pick
// -2500 pcm here so the "nominal" preset can sit critical at a moderate
// rod position (~0.7) without needing rods pulled dangerously far out.
const XE_REACTIVITY_AT_EQ = -0.025;              // target ρ at equilibrium Xe

// σ_Xe · φ_ref — Xe-135 burnup rate at n=1 (per second). Real physics: at
// a reactor thermal flux ~1e14 /cm²/s and Xe absorption cross-section
// ~2.6e6 barns, σφ ≈ 2.6e-4 /s (Xe burnup half-life ~44 min). This is
// SEPARATE from the reactivity worth (below) — worth uses a fixed
// proportionality, while σφ governs the DYNAMICS of Xe burn-in / burn-off.
const SIGMA_XE_PHI = 2.6e-4;                     // 1/s at n=1

// Thermal-hydraulic constants (lumped, per-reactor).
// Sized to real RBMK-1000 for nominal steady-state balance, but with the
// fuel heat capacity tuned SMALLER than raw mass·cp would give. This is
// because in a lumped model, C_fuel governs the Doppler feedback speed —
// too big and the reactor runs away before the fuel can heat up enough
// to Doppler-negate the reactivity insertion. The value below (τ_f ≈ 3 s
// at nominal ΔT ≈ 300 K) reproduces the fuel-response timescale for
// which Doppler effectively stabilizes small perturbations.
const P_NOMINAL_MW = 3200;                       // RBMK-1000 thermal power
const C_FUEL       = 3.2e7;                      // J/K  effective fuel capacity
const C_COOL       = 1.5e9;                      // J/K  coolant heat capacity
const H_FC         = 1.07e7;                     // W/K  fuel→coolant transfer
const M_DOT_CP     = 1.07e8;                     // W/K  ṁ·c_p at nominal flow
const T_INLET      = 543;                        // K   (270 °C — RBMK feed)
const T_SAT        = 600;                        // K   (~327 °C — well above nominal 300 °C hot leg)
const T_VOID_WIN   = 40;                         // K width of void ramp — voids build up gradually

// Failure thresholds — for event-log annotations, not for stopping the sim.
const T_FUEL_MELT       = 2800 + 273.15;         // UO₂ melting point (K)
const T_CLAD_FAIL       = 1200 + 273.15;         // Zircaloy runaway (K)
const N_PROMPT_CRITICAL = 1.0;                   // ρ/β > 1 (see event detector)

export const CONSTANTS = Object.freeze({
  BETA_TOTAL, BETA_I, KEEPIN_LAMBDA, LAMBDA,
  GAMMA_I, GAMMA_XE, LAMBDA_I, LAMBDA_XE,
  ALPHA_VOID, VOID_REF, ALPHA_D, T_FUEL_REF, XE_REACTIVITY_AT_EQ,
  P_NOMINAL_MW, C_FUEL, C_COOL, H_FC, M_DOT_CP,
  T_INLET, T_SAT, T_VOID_WIN,
  T_FUEL_MELT, T_CLAD_FAIL, N_PROMPT_CRITICAL,
});

// ─── State layout ─────────────────────────────────────────────────────
// A `State` is a plain object with these numeric fields. We keep it as
// an object (not a Float64Array) for readability — the RK4 hot path is
// still ~O(20) additions per step, which JS chews through easily.
//
//   n         — normalized neutron pop  (1 = 100% power)
//   c1..c6    — precursor pops, normalized to equilibrium at n=1
//   I, Xe     — I-135, Xe-135 concentrations (arbitrary units, self-consistent)
//   Tf, Tc    — fuel, coolant temperatures (K)
//   rod       — control rod position, 0=fully in, 1=fully out
//   rodPrev   — previous rod position (for direction-of-motion detection)
//
export function initialState({
  n = 1, rod = 0.5, Tf = 900, Tc = 550,
  Xe, I,             // optional overrides — otherwise compute equilibrium
  balanceRod = true, // auto-balance rod for ρ=0 at t=0 (nominal ops)
} = {}) {
  // Precursor equilibrium at n:  c_i = n  (in normalized form — see below)
  const c = KEEPIN_LAMBDA.map(() => n);

  // I / Xe equilibrium at n. We use the same φ ∝ n convention throughout.
  // Setting φ_ref = 1 at n=1 folds the Σ_f into the yield constants.
  const I0  = Number.isFinite(I) ? I : (GAMMA_I  * n) / LAMBDA_I;
  const XeEq = Number.isFinite(Xe) ? Xe
    : ((GAMMA_I + GAMMA_XE) * n)
      / (LAMBDA_XE + xenonAbsorption(n));

  // Auto-balance the rod position to put ρ_total = 0 at t=0. Real
  // reactor operators do this by tweaking the shim rod bank. Without
  // this the "nominal" preset drifts because Xe + Doppler add ~-6000
  // pcm and rod=0.5 (as spec'd) doesn't cancel them. Skip for scenarios
  // that WANT an imbalance (AZ-5 preset explicitly starts with rods
  // fully out to represent the operator error).
  let rod0 = rod;
  if (balanceRod) {
    // ρ_needed_from_rod = -(ρ_void + ρ_dopp + ρ_xe)
    // We can't easily invert rodWorth(rod) analytically, but the shape
    // is monotone in rod, so a few Newton iterations converge fast.
    const voidF = voidFraction(Tc);
    const target = -(voidReactivity(voidF)
                   + dopplerReactivity(Tf)
                   + xenonReactivity(XeEq));
    // ρ_rod(x) = 0.10·(x-0.5) + 0.02·(x-0.5)·|x-0.5|
    // For target ∈ [-0.07, +0.07] this maps cleanly to rod ∈ [0, 1].
    // Solve numerically: bisect on [0, 1].
    let lo = 0, hi = 1;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const y = rodWorth(mid);
      if (y < target) lo = mid; else hi = mid;
    }
    rod0 = (lo + hi) / 2;
  }

  return {
    n,
    c1: c[0], c2: c[1], c3: c[2], c4: c[3], c5: c[4], c6: c[5],
    I:  I0,
    Xe: XeEq,
    Tf, Tc,
    rod: rod0,
    rodPrev: rod0,
    // t_op — how long the reactor had been running before shutdown (s). Used
    // by the Way-Wigner decay-heat term. Default: 1 year steady state.
    tOp: 365 * 24 * 3600,
  };
}

// σ_Xe · φ  — burnup rate of Xe-135 per second at neutron level n. Uses
// the real physics constant SIGMA_XE_PHI (~2.6e-4 /s at n=1). This is
// what governs how fast Xe rebalances after a power change — it is
// SEPARATE from the reactivity worth proportionality, which is applied
// in xenonReactivity() below.
function xenonAbsorption(n) {
  return SIGMA_XE_PHI * n;
}

// ─── Reactivity model ─────────────────────────────────────────────────
// ρ_rod(rod) — rod-bank reactivity worth.
// Sign convention: rod=0 (fully in) is strongly negative, rod=1 (fully out)
// is strongly positive. The reactor is critical at ~rod = 0.5 in steady
// state (Doppler + Xe consume ~6000 pcm), so the curve crosses zero there.
// Shape is quadratic in (rod - 0.5) — smooth first derivative at the ends
// and a natural symmetric integral worth of ±10 000 pcm.
export function rodWorth(rod) {
  const x = Math.max(0, Math.min(1, rod));
  // Linear worth ρ_rod = 0.10 · (rod - 0.5) → ±5000 pcm at endpoints.
  // Plus a mild positive-going quadratic so full-out gives extra
  // supercritical margin — this matches a real bank of shim rods.
  return 0.10 * (x - 0.5) + 0.02 * (x - 0.5) * Math.abs(x - 0.5);
}

// The "positive scram" bump. When rods start entering from a nearly-full-out
// configuration, the graphite tip on the bottom 1.25 m of every rod
// displaces water in the *lower* core before the absorber section arrives.
// The result is a transient positive reactivity spike — up to ~ +β for a
// few seconds. We model it as a Gaussian centered ~2 s into an insertion,
// scaled by how far out the rods started and how fast they're moving in.
//
// Trigger condition: rod is moving downward (dr/dt < 0) AND started
// above ROD_TIP_THRESHOLD (nearly fully withdrawn). Once triggered we
// integrate a separate "tip" ODE — a bump that grows then decays.
// The peak bump amplitude comes from post-accident RBMK reanalysis. Reports
// cite a positive-scram reactivity insertion of "several β" over 4-5 s
// when rods were pulled out beyond the 30-cm operating reactivity margin.
// We use +6 β peak (≈ +3900 pcm) with a fast rise so the core goes prompt
// critical almost immediately — matching the ~4 s "AZ-5 press to peak
// power" timeline reported for Unit 4.
const ROD_TIP_THRESHOLD  = 0.90;   // rods must have been >90 % out
const ROD_TIP_MAX_RHO    = 6.0 * BETA_TOTAL;   // peak bump ≈ +6 β (≈ +3900 pcm)
const ROD_TIP_RISE_TAU   = 0.5;    // s — bump climbs to 90 % in ~1 s
const ROD_TIP_DECAY_TAU  = 4.0;    // s — how fast bump decays

// Doppler feedback — proportional to (Tf - T_ref). Sign is negative (α_D<0).
export function dopplerReactivity(Tf) {
  return ALPHA_D * (Tf - T_FUEL_REF);
}

// Void feedback. RBMK: strongly positive.
export function voidReactivity(voidFrac) {
  return ALPHA_VOID * (voidFrac - VOID_REF);
}

// Xenon reactivity — proportional to Xe concentration, normalized so
// equilibrium at n=1 lands on XE_REACTIVITY_AT_EQ. Xe_eq is calculated
// once at module load using the *real* burnup constant SIGMA_XE_PHI.
const XE_EQ_AT_N1 = ((GAMMA_I + GAMMA_XE) * 1) / (LAMBDA_XE + SIGMA_XE_PHI);
export function xenonReactivity(Xe) {
  if (!(XE_EQ_AT_N1 > 0)) return 0;
  return XE_REACTIVITY_AT_EQ * (Xe / XE_EQ_AT_N1);
}

// Void fraction from coolant temperature — 0 below T_SAT, ramps to 1 across
// T_VOID_WIN K of superheat. Physically crude but captures the sign flip
// of feedback that matters here.
export function voidFraction(Tc) {
  const x = (Tc - T_SAT) / T_VOID_WIN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);       // smoothstep
}

// ─── Point-kinetics — normalized precursor form ───────────────────────
// The raw point-kinetics equations are extremely stiff: Λ = 1e-4 s gives
// prompt-neutron dynamics on a 100 μs timescale, but xenon and thermal
// transients happen over seconds → hours. We handle this two ways:
//
//   (1) Normalize the precursor variable so equilibrium is c_i = n:
//         C_i (physics form) = c_i · β_i / (λ_i Λ)
//         →  Σ λ_i C_i = (1/Λ) Σ β_i c_i
//       So dn/dt = ((ρ - β)/Λ) n + (1/Λ) Σ β_i c_i
//          dc_i/dt = λ_i (n - c_i)                 ← nice and slow, no Λ
//       At equilibrium (n = c_i = 1, ρ = 0):  dn/dt = -β/Λ + β/Λ = 0. ✓
//
//   (2) Operator-split: substep the (n, c) subsystem at a fine internal
//       dt (≤ 100 μs) using RK4, while the slow variables (I, Xe, T_f,
//       T_c, rod) are integrated with the outer dt. The slow-state
//       "context" (ρ, cooling terms) is held constant across each
//       inner-substep window — a standard first-order splitting.
//
// This gives numerical stability without an implicit solver.

// ─── Fast RHS: neutron kinetics only (n, c1..c6) ──────────────────────
// `rho` is the total reactivity, treated as constant during a substep.
function fastRhs(n, c, rho) {
  let sumBc = 0;
  for (let i = 0; i < 6; i++) sumBc += BETA_I[i] * c[i];
  const dn = ((rho - BETA_TOTAL) / LAMBDA) * n + sumBc / LAMBDA;
  const dc = new Array(6);
  for (let i = 0; i < 6; i++) dc[i] = KEEPIN_LAMBDA[i] * (n - c[i]);
  return { dn, dc };
}

// One RK4 substep on (n, c). Returns new (n, c) after advancing by h.
function fastStepRK4(n, c, h, rho) {
  const addC = (a, b, s) => a.map((ai, i) => ai + b[i] * s);
  const k1 = fastRhs(n, c, rho);
  const n2 = n + k1.dn * h / 2; const c2 = addC(c, k1.dc, h / 2);
  const k2 = fastRhs(n2, c2, rho);
  const n3 = n + k2.dn * h / 2; const c3 = addC(c, k2.dc, h / 2);
  const k3 = fastRhs(n3, c3, rho);
  const n4 = n + k3.dn * h;     const c4 = addC(c, k3.dc, h);
  const k4 = fastRhs(n4, c4, rho);
  const nOut = n + (h / 6) * (k1.dn + 2 * k2.dn + 2 * k3.dn + k4.dn);
  const cOut = c.map(
    (ci, i) => ci + (h / 6) * (k1.dc[i] + 2 * k2.dc[i] + 2 * k3.dc[i] + k4.dc[i]),
  );
  return { n: nOut, c: cOut };
}

// Substep (n, c) over the outer window `H` in fine chunks of at most
// FAST_DT_MAX. We also clamp to a minimum step count so short outer
// windows still get several inner steps.
const FAST_DT_MAX = 1e-4;          // s — one prompt neutron lifetime
const FAST_STEPS_MIN = 5;

function advanceFast(n, c, H, rho) {
  const nsteps = Math.max(FAST_STEPS_MIN, Math.ceil(H / FAST_DT_MAX));
  const h = H / nsteps;
  let ni = n;
  let ci = c;
  for (let k = 0; k < nsteps; k++) {
    const step = fastStepRK4(ni, ci, h, rho);
    ni = step.n;
    ci = step.c;
    if (!Number.isFinite(ni) || ni < 0) ni = 0;
    for (let j = 0; j < 6; j++) if (ci[j] < 0) ci[j] = 0;
  }
  return { n: ni, c: ci };
}

// ─── Slow RHS: I, Xe, Tf, Tc — everything except n and c ──────────────
function slowRhs(s, ctx) {
  const { flowMult } = ctx;
  const dI_dt  = GAMMA_I * s.n - LAMBDA_I * s.I;
  const dXe_dt = GAMMA_XE * s.n
               + LAMBDA_I * s.I
               - LAMBDA_XE * s.Xe
               - xenonAbsorption(s.n) * s.Xe;
  const P = s.n * P_NOMINAL_MW * 1e6;
  const dTf_dt = (P - H_FC * (s.Tf - s.Tc)) / C_FUEL;
  const dTc_dt = (H_FC * (s.Tf - s.Tc) - M_DOT_CP * flowMult * (s.Tc - T_INLET))
               / C_COOL;
  return { I: dI_dt, Xe: dXe_dt, Tf: dTf_dt, Tc: dTc_dt };
}

function slowStepRK4(state, h, ctx) {
  const k1 = slowRhs(state, ctx);
  const s2 = {
    ...state,
    I:  state.I  + k1.I  * h / 2,
    Xe: state.Xe + k1.Xe * h / 2,
    Tf: state.Tf + k1.Tf * h / 2,
    Tc: state.Tc + k1.Tc * h / 2,
  };
  const k2 = slowRhs(s2, ctx);
  const s3 = {
    ...state,
    I:  state.I  + k2.I  * h / 2,
    Xe: state.Xe + k2.Xe * h / 2,
    Tf: state.Tf + k2.Tf * h / 2,
    Tc: state.Tc + k2.Tc * h / 2,
  };
  const k3 = slowRhs(s3, ctx);
  const s4 = {
    ...state,
    I:  state.I  + k3.I  * h,
    Xe: state.Xe + k3.Xe * h,
    Tf: state.Tf + k3.Tf * h,
    Tc: state.Tc + k3.Tc * h,
  };
  const k4 = slowRhs(s4, ctx);
  return {
    ...state,
    I:  state.I  + (h / 6) * (k1.I  + 2 * k2.I  + 2 * k3.I  + k4.I),
    Xe: state.Xe + (h / 6) * (k1.Xe + 2 * k2.Xe + 2 * k3.Xe + k4.Xe),
    Tf: state.Tf + (h / 6) * (k1.Tf + 2 * k2.Tf + 2 * k3.Tf + k4.Tf),
    Tc: state.Tc + (h / 6) * (k1.Tc + 2 * k2.Tc + 2 * k3.Tc + k4.Tc),
  };
}

// ─── One combined step ────────────────────────────────────────────────
// Advances the full state by outer dt `h`. Order:
//   1. Compute reactivity from current state.
//   2. Substep neutron kinetics (n, c) by h with the fine RK4.
//   3. Step slow variables (I, Xe, Tf, Tc) by h with RK4.
//   4. Slew rod position toward rodCmd.
// This is first-order operator splitting — good enough here since the
// outer dt (0.02-0.1 s) is much less than every slow time constant.
export function stepRK4(state, h, ctx) {
  const { rodCmd, rodSlewRate, tipBump } = ctx;
  const voidF   = voidFraction(state.Tc);
  const rhoRod  = rodWorth(state.rod) + tipBump;
  const rhoVoid = voidReactivity(voidF);
  const rhoDopp = dopplerReactivity(state.Tf);
  const rhoXe   = xenonReactivity(state.Xe);
  const rho     = rhoRod + rhoVoid + rhoDopp + rhoXe;

  // Fast substep.
  const cArr = [state.c1, state.c2, state.c3, state.c4, state.c5, state.c6];
  const fast = advanceFast(state.n, cArr, h, rho);

  // Slow step.
  const slow = slowStepRK4(state, h, ctx);

  // Rod slew — clamped to [0, 1].
  const rodErr  = rodCmd - state.rod;
  const rodStep = Math.sign(rodErr) * Math.min(Math.abs(rodErr), rodSlewRate * h);
  const rodNext = Math.max(0, Math.min(1, state.rod + rodStep));

  return {
    ...state,
    n: fast.n,
    c1: fast.c[0], c2: fast.c[1], c3: fast.c[2],
    c4: fast.c[3], c5: fast.c[4], c6: fast.c[5],
    I:  slow.I,
    Xe: slow.Xe,
    Tf: slow.Tf,
    Tc: slow.Tc,
    rodPrev: state.rod,
    rod: rodNext,
  };
}

// ─── Way-Wigner decay heat ────────────────────────────────────────────
// P_d(t) = 0.066 · P₀ · (t^-0.2 − (t + t_op)^-0.2)
// Fired when n gets small (< 1e-3) — post-shutdown, fission is off but the
// fission-product decay chain still puts ~6 % of nominal power into the
// fuel for tens of seconds, decaying slowly for hours.
export function decayHeatMW(t, tOp, P0MW) {
  if (!(t > 0)) return 0;
  const term = Math.pow(t, -0.2) - Math.pow(t + tOp, -0.2);
  return 0.066 * P0MW * term;
}

// ─── Event detection ──────────────────────────────────────────────────
// Fires human-readable log entries as thresholds are crossed. Uses a
// `flags` object to avoid re-emitting the same event every step.
function pushEvent(events, t, level, msg) {
  events.push({ t: Number(t.toFixed(3)), level, msg });
}

function detectEvents(prev, next, diag, t, flags, events) {
  const beta = BETA_TOTAL;
  const rhoOverBeta = diag.rho / beta;

  // Prompt critical (ρ > β)  ← the definition of "supercritical on prompt
  // neutrons alone" — power doubles on the neutron generation time (10⁻⁴ s
  // in a thermal reactor), not the delayed period.
  if (!flags.promptCrit && rhoOverBeta > 1.0) {
    flags.promptCrit = true;
    pushEvent(events, t, 'crit',
      `PROMPT CRITICAL: ρ/β = ${rhoOverBeta.toFixed(2)} — power runaway imminent`);
  }
  if (flags.promptCrit && rhoOverBeta < 0.9) {
    flags.promptCrit = false;
  }

  // Positive-scram spike — fires when the graphite tip bump alone (not
  // the rod-worth curve) is adding meaningful positive reactivity while
  // the rods are entering the core.
  if (!flags.tipSpike && diag.tipBump > 0.3 * beta && next.rod < prev.rod) {
    flags.tipSpike = true;
    pushEvent(events, t, 'crit',
      `POSITIVE SCRAM EFFECT: graphite tips added +${(diag.tipBump * 1e5).toFixed(0)} pcm as rods enter`);
  }

  // Fuel melt.
  if (!flags.melt && next.Tf > T_FUEL_MELT) {
    flags.melt = true;
    pushEvent(events, t, 'crit',
      `FUEL MELT: T_f = ${(next.Tf - 273.15).toFixed(0)} °C > 2800 °C — core destroyed`);
  }

  // Cladding failure (Zr steam reaction runs away → H₂).
  if (!flags.cladFail && next.Tf > T_CLAD_FAIL) {
    flags.cladFail = true;
    pushEvent(events, t, 'warn',
      `CLAD FAILURE: T_f = ${(next.Tf - 273.15).toFixed(0)} °C — Zr-H₂O reaction, hydrogen production`);
  }

  // Boiling crisis — coolant sat + high void.
  if (!flags.boiling && diag.voidF > 0.3) {
    flags.boiling = true;
    pushEvent(events, t, 'warn',
      `BOILING: void fraction = ${(diag.voidF * 100).toFixed(0)} % — positive void feedback engaging`);
  }
  if (!flags.boilingCrisis && diag.voidF > 0.75) {
    flags.boilingCrisis = true;
    pushEvent(events, t, 'crit',
      `BOILING CRISIS: void = ${(diag.voidF * 100).toFixed(0)} % — coolant flow collapsing`);
  }

  // Xenon peak / dead-band. Rising Xe drives ρ_Xe strongly negative.
  if (!flags.xenonPeak && diag.rhoXe < -0.04) {
    flags.xenonPeak = true;
    pushEvent(events, t, 'warn',
      `XENON POISONED: ρ_Xe = ${(diag.rhoXe * 1e5).toFixed(0)} pcm — reactor entering "iodine pit"`);
  }

  // Power spike.
  if (!flags.powerSpike && next.n > 10) {
    flags.powerSpike = true;
    pushEvent(events, t, 'crit',
      `POWER SPIKE: n = ${next.n.toFixed(1)}× nominal (${(next.n * P_NOMINAL_MW).toFixed(0)} MW)`);
  }

  // Runaway (sanity — huge n).
  if (!flags.runaway && next.n > 100) {
    flags.runaway = true;
    pushEvent(events, t, 'crit',
      `RUNAWAY: n = ${next.n.toExponential(2)}× nominal — vessel rupture`);
  }
}

// ─── The main simulator ───────────────────────────────────────────────
// Runs the reactor for `duration` seconds. `control` is an array of
// timed actions:
//   { t, action, value }
//   action ∈ { 'rod', 'scram', 'flow' }
//     'rod'   — set rod target position (0..1)
//     'scram' — press AZ-5 (rod target → 0, at scram slew rate)
//     'flow'  — coolant flow multiplier (1.0 = nominal)
//
// Options:
//   duration (s) — total sim time  (hard cap: 300 s in controller)
//   dt (s)       — integration step (min: 1e-3 s in controller)
//   maxPoints    — output downsample budget (default 6000)
//
// Returns { series, events, verdict, meta } — see top-level comment.
export function simulate({
  initial,
  duration = 60,
  dt       = 0.05,
  control  = [],
  maxPoints = 6000,
} = {}) {
  // Build the initial state from user overrides. initialState() already
  // computes self-consistent equilibrium precursors and Xe/I from the
  // given n — so we MUST pass the overrides *into* initialState, not
  // just spread on top afterwards (spreading afterwards would leave
  // c_i at the default-n equilibrium, blowing up the sim).
  const state0 = initialState(initial || {});
  let state = state0;

  // Sort control events ascending in time so we can pop them off in order.
  const controls = [...control]
    .filter((c) => c && Number.isFinite(Number(c.t)))
    .map((c) => ({ ...c, t: Number(c.t) }))
    .sort((a, b) => a.t - b.t);

  // Runtime "context" — rod command, flow, tip-bump internal.
  let rodCmd      = state0.rod;
  let rodSlewRate = 0.02;   // /s — normal manual movement (fully in/out ≈ 50 s)
  let flowMult    = 1.0;
  let scrammed    = false;
  let scramT      = null;    // wall-time (sim seconds) when AZ-5 was pressed

  // Tip-bump internal state: total elapsed since scram-triggered insertion
  // began, and a saved "rodStartPos" for scaling the bump amplitude.
  let tipT0 = null;
  let tipStartRod = null;

  const steps = Math.max(1, Math.floor(duration / dt));
  const stride = Math.max(1, Math.ceil((steps + 1) / maxPoints));

  const series = [];
  const events = [];
  const flags  = {};

  const rhoDollars = (rho) => rho / BETA_TOTAL;

  const pushSample = (t, s, diag) => {
    series.push({
      t: Number(t.toFixed(4)),
      n_rel: s.n,
      power_MW: s.n * P_NOMINAL_MW,
      T_fuel: s.Tf,
      T_coolant: s.Tc,
      void: diag.voidF,
      rod_pos: s.rod,
      xenon: s.Xe,
      iodine: s.I,
      rho_total:   diag.rho,
      rho_control: diag.rhoRod,
      rho_void:    diag.rhoVoid,
      rho_doppler: diag.rhoDopp,
      rho_xenon:   diag.rhoXe,
      rho_dollars: rhoDollars(diag.rho),
    });
  };

  // Initial diagnostic sample.
  {
    const voidF   = voidFraction(state.Tc);
    const rhoRod  = rodWorth(state.rod);
    const rhoVoid = voidReactivity(voidF);
    const rhoDopp = dopplerReactivity(state.Tf);
    const rhoXe   = xenonReactivity(state.Xe);
    const rho     = rhoRod + rhoVoid + rhoDopp + rhoXe;
    pushSample(0, state, { rho, rhoRod, rhoVoid, rhoDopp, rhoXe, voidF, P: state.n * P_NOMINAL_MW * 1e6 });
  }

  for (let i = 1; i <= steps; i++) {
    const t = i * dt;

    // Apply any control events whose time we've reached.
    while (controls.length && controls[0].t <= t) {
      const c = controls.shift();
      if (c.action === 'rod' && Number.isFinite(Number(c.value))) {
        rodCmd = Math.max(0, Math.min(1, Number(c.value)));
        pushEvent(events, c.t, 'info', `Rod target → ${(rodCmd * 100).toFixed(0)} %`);
      } else if (c.action === 'scram') {
        // AZ-5 — rods slam in at ~5 %/s. On RBMK this took ~18-20 s for
        // full insertion; here 0.05/s over ~20 s is close enough.
        if (!scrammed) {
          scrammed = true;
          scramT = c.t;
          tipT0 = t;
          tipStartRod = state.rod;
          rodCmd = 0;
          rodSlewRate = 0.05;
          pushEvent(events, c.t, 'crit', `AZ-5 SCRAM pressed (rods at ${(state.rod * 100).toFixed(0)} % out)`);
        }
      } else if (c.action === 'flow' && Number.isFinite(Number(c.value))) {
        flowMult = Math.max(0, Number(c.value));
        pushEvent(events, c.t, 'info', `Coolant flow → ${(flowMult * 100).toFixed(0)} %`);
      }
    }

    // Also trigger a passive tip-bump if the rod happens to start entering
    // from >90 % out with no explicit scram (e.g. custom rod-in command).
    if (tipT0 === null && rodCmd < state.rod && state.rod > ROD_TIP_THRESHOLD) {
      tipT0 = t;
      tipStartRod = state.rod;
    }

    // Compute the current tip-bump reactivity. Log-normal-ish shape:
    // rises with τ_rise, decays with τ_decay, amplitude scales with how
    // dangerously withdrawn rods were. The amplitude uses (rod - 0.8)²
    // rather than a linear ramp so the effect only becomes SEVERE when
    // rods are pulled dangerously far (approaching the ORM violation that
    // preceded Chernobyl — <15 rod-equivalents left in the core).
    let tipBump = 0;
    if (tipT0 !== null) {
      const τ = t - tipT0;
      const overpull = Math.max(0, tipStartRod - 0.8);   // 0 below 80 % out
      const amp = ROD_TIP_MAX_RHO * Math.min(1, overpull / 0.15);   // full amp at ≥ 95 %
      const rise = 1 - Math.exp(-τ / ROD_TIP_RISE_TAU);
      const decay = Math.exp(-τ / ROD_TIP_DECAY_TAU);
      tipBump = amp * rise * decay;
      if (τ > 6 * ROD_TIP_DECAY_TAU) tipT0 = null;   // bump exhausted
    }

    const prev = state;
    const ctx = { rodCmd, rodSlewRate, flowMult, tipBump };
    state = stepRK4(state, dt, ctx);

    // Numerical guardrails — n can't be negative, temperatures can't be too
    // silly. If n underflows to 0 keep it non-negative so log/exp downstream
    // is defined.
    if (!Number.isFinite(state.n) || state.n < 0) state.n = 0;
    if (state.I  < 0) state.I  = 0;
    if (state.Xe < 0) state.Xe = 0;

    // Post-shutdown decay heat: once fission has collapsed, add residual
    // heating from fission-product decay directly to Tf. Uses the Way-Wigner
    // approximation, valid for t ≳ 1 s post-shutdown.
    if (state.n < 1e-3 && scrammed && scramT !== null) {
      const tSinceScram = Math.max(1, t - scramT);
      const P_d = decayHeatMW(tSinceScram, state0.tOp, P_NOMINAL_MW) * 1e6; // W
      state.Tf += (P_d - H_FC * (state.Tf - state.Tc)) * dt / C_FUEL;
    }

    // Compute diagnostics on the *new* state for event detection & sampling.
    const voidF   = voidFraction(state.Tc);
    const rhoRod  = rodWorth(state.rod) + tipBump;
    const rhoVoid = voidReactivity(voidF);
    const rhoDopp = dopplerReactivity(state.Tf);
    const rhoXe   = xenonReactivity(state.Xe);
    const rho     = rhoRod + rhoVoid + rhoDopp + rhoXe;
    const diag    = { rho, rhoRod, rhoVoid, rhoDopp, rhoXe, voidF, tipBump, P: state.n * P_NOMINAL_MW * 1e6 };

    detectEvents(prev, state, diag, t, flags, events);

    if (i % stride === 0 || i === steps) {
      pushSample(t, state, diag);
    }
  }

  // ─── Verdict ────────────────────────────────────────────────────────
  // Pick a headline label for the outcome, in priority order.
  //   meltdown           — fuel above melt point OR n runaway to > 100×
  //   runaway            — went prompt-critical but stopped short of melt
  //   shutdown-poisoned  — reactor sub-critical AND xenon is meaningfully
  //                        elevated above equilibrium (still climbing)
  //   scram-safe         — scrammed and shut down cleanly
  //   stable             — nothing dramatic happened (nominal ops)
  const finalRhoXeMag = Math.abs(xenonReactivity(state.Xe));
  const xenonHeavy = finalRhoXeMag > 0.03; // > 3000 pcm poisoning
  let verdict = 'stable';
  if (flags.melt || flags.runaway) verdict = 'meltdown';
  else if (flags.promptCrit && !flags.melt) verdict = 'runaway';
  else if (state.n < 0.01 && (xenonHeavy || flags.xenonPeak)) verdict = 'shutdown-poisoned';
  else if (scrammed && state.n < 0.01) verdict = 'scram-safe';
  else if (state.n < 0.01) verdict = 'scram-safe';  // controlled shutdown

  return {
    series,
    events,
    verdict,
    meta: {
      steps,
      stride,
      dt,
      duration,
      betaTotal: BETA_TOTAL,
      lambda: LAMBDA,
      finalState: {
        n: state.n,
        Tf: state.Tf,
        Tc: state.Tc,
        rod: state.rod,
        Xe: state.Xe,
        I:  state.I,
      },
    },
  };
}

// ─── Preset scenarios ─────────────────────────────────────────────────
// Public catalogue for GET /api/chernobyl/scenarios. Each scenario has:
//   - id: URL-safe key
//   - title, description, expected verdict (for FE hinting)
//   - a `build()` function returning { initial, duration, dt, control }
//     ready to feed into `simulate`.
export const SCENARIOS = [
  {
    id: 'nominal',
    title: 'Nominal steady operation',
    description:
      'Reactor at 100 % rated power, rods at ~50 %, coolant flow nominal. '
      + 'Nothing changes — a sanity run showing the model is at equilibrium.',
    expected: 'stable',
    build: () => ({
      initial: { n: 1.0, rod: 0.5, Tf: 873, Tc: 573 },
      duration: 60,
      dt: 0.05,
      control: [],
    }),
  },
  {
    id: 'xenon-transient',
    title: 'Xenon poisoning / iodine pit onset',
    description:
      'Cut power sharply and watch I-135 keep decaying into Xe-135 with '
      + 'no burnup to compensate. Xenon reactivity swings strongly negative '
      + 'over ~6-11 h in reality; in this 300 s window you\'ll see the '
      + 'characteristic rise of Xe and drop of total reactivity — the trap '
      + 'that led operators at Chernobyl to withdraw rods dangerously far.',
    expected: 'scram-safe',
    build: () => ({
      initial: { n: 1.0, rod: 0.5, Tf: 873, Tc: 573 },
      duration: 300,
      dt: 0.1,
      control: [
        { t: 5,  action: 'rod', value: 0.35 },  // drop power sharply
      ],
    }),
  },
  {
    id: 'az5-scram',
    title: 'AZ-5 SCRAM at low power with rods withdrawn (Chernobyl-1986)',
    description:
      'Reproduce the 26 April 1986 setup: reactor throttled way down '
      + '(xenon-poisoned), operators pulled nearly all rods out to keep it '
      + 'critical, coolant flow reduced. At t=25 s AZ-5 is pressed → the '
      + 'graphite tips add positive reactivity as they enter the bottom of '
      + 'the core → prompt criticality → runaway → fuel melt.',
    expected: 'meltdown',
    build: () => ({
      // NOTE: balanceRod:true — with rods at 95 % out AND heavy Xe
      // poisoning, the reactor really was ~critical at 200 MW that
      // night (operators had wound rods out to fight the iodine pit).
      // We keep the rod-position command at 0.95, but let the balancer
      // fine-tune the intrinsic rod offset so we start at ρ ≈ 0.
      initial: {
        n: 0.07,          // ~200 MW / 3200 MW — Chernobyl operating point
        rod: 0.95,        // nearly all rods withdrawn (operating reserve <<)
        Tf: 900,
        Tc: 595,          // 5 K below saturation → any perturbation → voids
        // Xenon deliberately elevated: at n=1 equilibrium Xe ≈ 236.
        // The 1986 operating point was deep in the iodine pit after the
        // earlier power ramp-down — Xe ~1.6× equilibrium. This gives
        // ~4200 pcm of intrinsic negative reactivity that the operators
        // fought by pulling rods to 95 % out. Result: ρ_total near zero
        // but with almost no shutdown margin.
        Xe: 380,
        I:  2100,
        balanceRod: false,
      },
      duration: 60,
      dt: 0.02,
      control: [
        { t: 5,  action: 'flow', value: 0.5 },  // low coolant flow
        { t: 25, action: 'scram' },              // press AZ-5 — the fatal moment
      ],
    }),
  },
  {
    id: 'controlled-shutdown',
    title: 'Controlled shutdown from full power',
    description:
      'Rods driven in slowly from mid-position with full coolant flow. '
      + 'No graphite-tip spike because rods start well below the 90 % '
      + 'threshold. Power decays cleanly onto the delayed-neutron tail.',
    expected: 'scram-safe',
    build: () => ({
      initial: { n: 1.0, rod: 0.5, Tf: 873, Tc: 573 },
      duration: 60,
      dt: 0.05,
      control: [
        { t: 5, action: 'rod', value: 0.0 },
      ],
    }),
  },
];
