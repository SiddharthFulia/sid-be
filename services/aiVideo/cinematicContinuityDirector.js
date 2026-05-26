// Cinematic Continuity Director (§64 → §69).
//
// Job: take a planned cinema project (bible + directorState + shot actions)
// and compile each shot into a TRUE continuation of the previous one —
// not a standalone scene. Six things the chain delegates here:
//
//   • compileContinuityPrompt   → final positive prompt for the shot
//   • buildContinuityNegativePrompt → negative prompt (where workflow supports it)
//   • sanitizeShotAction        → strip drift words from a user/Groq action
//   • getCameraContinuationInstruction
//   • getPhysicalContinuationInstruction
//   • calculateContinuityRisk   → 0-100 risk score per shot
//
// Plus a small constant table mapping each model to its safer Cinema
// defaults (motion strength, max recommended shot length, etc.) so the
// chain can warn the user before rendering.
//
// No DB writes in this module — it's pure functions. The chain stores
// outputs onto job rows + job_logs.

import fs from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

// ─── Constants ──────────────────────────────────────────────────────

// Words that signal a SHOT-LEVEL world reset. If a shot's action
// mentions any of these, the action is treated as drift and either
// auto-rewritten (sanitizeShotAction) or flagged in the risk score.
export const DRIFT_WORDS = [
  // location resets
  'different location', 'new world', 'new location', 'another place',
  'different scene', 'new scene', 'new environment', 'different setting',
  // subject resets
  'different character', 'new character', 'another character',
  'different animal', 'new animal', 'another animal',
  'different person', 'new person',
  'transforms into', 'turns into', 'morphs into', 'changes into',
  // time-of-day resets
  'suddenly night', 'suddenly day', 'moonlight', 'sunset becomes',
  // fantasy / surreal triggers
  'surreal', 'dreamlike', 'fantasy', 'magical transformation',
  'teleport', 'flying through space',
  // camera resets
  'whip pan', 'rapid zoom', 'crash zoom', 'spinning camera',
  'extreme camera move', 'camera flies above',
];

// Per-model safer defaults when continuityMode is on. The chain reads
// `motionStrength` from here as a hard cap and `maxRecommendedShotSeconds`
// for the risk score (longer shots on weaker models = higher risk).
export const CONTINUITY_MODEL_DEFAULTS = {
  'wan-2.2':     { motionStrength: 0.45, steps: 18, bestFor: 'balanced continuity',      maxRecommendedShotSeconds: 6 },
  'wan-2.1-i2v': { motionStrength: 0.40, steps: 20, bestFor: 'best continuity',          maxRecommendedShotSeconds: 8 },
  'wan-2.1':     { motionStrength: 0.45, steps: 20, bestFor: 'cinematic motion',         maxRecommendedShotSeconds: 6 },
  'hunyuan':     { motionStrength: 0.35, steps: 20, bestFor: 'cinematic realism',        maxRecommendedShotSeconds: 8 },
  'ltx-video':   { motionStrength: 0.35, steps: 30, bestFor: 'fast preview',             maxRecommendedShotSeconds: 5 },
  'ltx-distilled':{ motionStrength: 0.35, steps: 8,  bestFor: 'fast preview only',       maxRecommendedShotSeconds: 4 },
  'mochi':       { motionStrength: 0.40, steps: 30, bestFor: 'distinctive style',        maxRecommendedShotSeconds: 6 },
  'svd':         { motionStrength: 0.50, steps: 25, bestFor: 'image animation',          maxRecommendedShotSeconds: 5 },
};

// Realism layer — appended to every shot's positive prompt when
// project.realismMode is on. Keeps the model honest about physics +
// camera operator behaviour.
export const REALISM_LAYER = (
  'realistic documentary cinematography, grounded physics, ' +
  'natural imperfect motion, subtle camera operator sway, ' +
  'real lens behaviour, natural motion blur, consistent shadows, ' +
  'consistent scale, believable contact with ground, ' +
  'no morphing, no plastic texture, no over-smoothed AI look'
);

// Cinema-default negative prompt. Composed with bible-aware additions
// inside buildContinuityNegativePrompt().
const NEGATIVE_BASE = [
  'morphing', 'identity change', 'new character', 'duplicated subject',
  'disappearing subject', 'floating feet', 'floating paws',
  'broken anatomy', 'extra limbs',
  'plastic AI texture', 'over-saturated', 'cartoon look',
  'sudden location change', 'time of day change',
  'camera jump', 'perspective flip', 'inconsistent lighting',
  'inconsistent scale', 'surreal artifacts', 'melting objects',
  'frame warping', 'low realism', 'fake CGI look', 'uncanny valley',
];

// ─── Sanitization ───────────────────────────────────────────────────

// Returns { cleaned, removed } — `removed` is the list of drift phrases
// stripped out so the chain can surface them in the log.
export function sanitizeShotAction(action, directorState = {}) {
  if (!action || typeof action !== 'string') return { cleaned: '', removed: [] };
  let cleaned = action;
  const removed = [];
  for (const phrase of DRIFT_WORDS) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (re.test(cleaned)) {
      removed.push(phrase);
      cleaned = cleaned.replace(re, '').replace(/\s+/g, ' ').trim();
    }
  }
  // Drop trailing junk left by removals (e.g. "the wolf catches scent in a")
  cleaned = cleaned.replace(/\b(in|at|on|under|with|to|from)\s*$/i, '').trim();
  return { cleaned, removed };
}

// ─── Camera + physical continuation ─────────────────────────────────

export function getCameraContinuationInstruction(prevShot, currentShot, cameraState) {
  const cs = cameraState || {};
  if (!prevShot) {
    // Opening shot — no continuation, just state-of-the-world.
    const lens = cs.lens ? `${cs.lens} lens` : 'cinematic lens';
    const movement = cs.movement || 'slow camera move';
    const energy = cs.energy ? `${cs.energy} energy` : 'calm energy';
    const stab = cs.stabilization || 'slightly handheld with subtle operator sway';
    return `Camera: ${lens}, ${movement}, ${energy}, ${stab}. Opening shot.`;
  }
  const movement = cs.movement || 'tracking move';
  return (
    `Camera continues the previous ${movement} momentum, ` +
    'remains on the same side of the subject, ' +
    'no sudden framing reset, no reversed screen direction, ' +
    'natural acceleration and deceleration, ' +
    'subtle handheld operator sway, ' +
    'NOT a perfectly smooth camera — slight inertia and imperfection.'
  );
}

export function getPhysicalContinuationInstruction(prevShot, currentShot, physicalState) {
  const ps = physicalState || {};
  if (!prevShot) {
    const parts = [];
    if (ps.screenDirection)  parts.push(`subjects move ${ps.screenDirection}`);
    if (ps.subjectMotion)    parts.push(ps.subjectMotion);
    if (ps.windDirection)    parts.push(`wind blowing ${ps.windDirection}`);
    if (ps.weatherIntensity && ps.weatherIntensity !== 'none') parts.push(`weather: ${ps.weatherIntensity}`);
    if (ps.terrain)          parts.push(`terrain: ${ps.terrain}`);
    if (ps.timeOfDay)        parts.push(`time of day: ${ps.timeOfDay}`);
    return parts.length ? `Establish: ${parts.join(', ')}.` : '';
  }
  // Continuation shot — explicitly forbid the model from resetting motion.
  const dir = ps.screenDirection || 'in the established direction';
  const parts = [
    `Subjects continue moving ${dir} across the same terrain`,
    'paws / feet maintain believable ground contact',
    'no teleporting, no pose reset, no change in scale',
  ];
  if (ps.windDirection)   parts.push(`wind keeps blowing ${ps.windDirection}`);
  if (ps.snowDirection || ps.weatherDirection) parts.push(`${ps.snowDirection ? 'snow' : 'weather'} continues in the same direction`);
  if (ps.timeOfDay)       parts.push(`same ${ps.timeOfDay} lighting`);
  return parts.join(', ') + '.';
}

// ─── Negative prompt builder ────────────────────────────────────────

export function buildContinuityNegativePrompt({ bible = {}, directorState = {}, shot = {} } = {}) {
  const parts = [...NEGATIVE_BASE];
  // Bible-derived negatives — if the bible says "snowy mountain", we
  // explicitly NEGATIVE "desert", "city", "indoor" to prevent
  // mid-render scene shifts.
  const env = (bible.environment || '').toLowerCase();
  if (env.includes('snow') || env.includes('mountain')) parts.push('desert', 'city street', 'indoor room', 'beach');
  if (env.includes('beach') || env.includes('ocean'))   parts.push('snow', 'mountain', 'city street', 'indoor');
  if (env.includes('space') || env.includes('alien'))   parts.push('earth city', 'desert', 'forest');
  // Director-state negatives
  const rules = Array.isArray(directorState.negativeContinuityRules) ? directorState.negativeContinuityRules : [];
  for (const r of rules) {
    if (typeof r === 'string' && r.trim()) parts.push(r.trim().replace(/^(do not|don'?t|avoid)\s+/i, ''));
  }
  // Deduplicate while preserving order.
  const seen = new Set(); const out = [];
  for (const p of parts) {
    const k = p.toLowerCase().trim();
    if (k && !seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out.join(', ');
}

// ─── The main compiler ─────────────────────────────────────────────

// Compose the full positive prompt for one shot. The layer order is
// deliberate — bible first, then world physics, then camera, then
// continuation language, then the shot's own action, then realism
// rules. Tests have shown longer prompts tail off in influence so
// putting the most identity-anchoring content first matters.
export function compileContinuityPrompt({
  bible = {},
  directorState = {},
  shot = {},
  previousShot = null,
  shotIndex = 0,
  totalShots = 1,
  realismMode = true,
} = {}) {
  const warnings = [];

  // 1. Locked visual bible.
  const bibleFields = ['subject', 'wardrobe', 'environment', 'lighting', 'camera', 'palette'];
  const bibleLine = bibleFields
    .map(k => (bible[k] || '').toString().trim())
    .filter(Boolean)
    .map(v => `same ${v}`).join(', ');

  // 2. Locked physical state (wind, screen direction, terrain).
  const physicalLine = getPhysicalContinuationInstruction(previousShot, shot, directorState.physicalState);

  // 3. Locked camera state.
  const cameraLine = getCameraContinuationInstruction(previousShot, shot, directorState.cameraState);

  // 4. Continuation phrase. Opening shot gets a softer "establishing"
  //    phrase; every later shot is explicitly a continuation.
  const continuationLine = shotIndex === 0
    ? 'Establishing shot of the scene.'
    : 'Continuation of the previous shot — subjects keep moving without teleporting or changing direction.';

  // 5. The shot's own action — sanitized for drift.
  const rawAction = (typeof shot === 'string' ? shot : shot.action || '').trim();
  const { cleaned: cleanedAction, removed: removedDrift } = sanitizeShotAction(rawAction, directorState);
  if (removedDrift.length) warnings.push(`drift removed: ${removedDrift.join(', ')}`);

  // 6. Realism layer (toggleable).
  const realismLine = realismMode ? REALISM_LAYER : '';

  // 7. Compose. Sentences separated by `. ` so each layer reads as
  //    discrete instructions to the text encoder.
  const parts = [
    bibleLine,
    physicalLine,
    cameraLine,
    continuationLine,
    cleanedAction,
    realismLine,
  ].filter(Boolean);
  const positivePrompt = parts.join('. ').replace(/\.{2,}/g, '.').replace(/\s+\./g, '.').trim();

  // 8. Negative prompt
  const negativePrompt = buildContinuityNegativePrompt({ bible, directorState, shot });

  // 9. Compact one-line log summary for job_logs.
  // Defensive — every `.length` here protected so a missing field
  // (corrupt row, partial Groq output) can't poison the chain log line.
  const _bibleFilled = bibleFields.filter(k => typeof bible?.[k] === 'string' && bible[k].trim()).length;
  const _driftCount  = Array.isArray(removedDrift) ? removedDrift.length : 0;
  const _negLen      = typeof negativePrompt === 'string' ? negativePrompt.length : 0;
  const compactLogSummary = (
    `shot ${shotIndex + 1}/${totalShots} · ` +
    `bible=${_bibleFilled}/6 · ` +
    `continuation=${shotIndex > 0} · ` +
    `drift_removed=${_driftCount} · ` +
    `realism=${!!realismMode} · ` +
    `negative=${_negLen > 0}`
  );

  return {
    positivePrompt,
    negativePrompt,
    compactLogSummary,
    continuityWarnings: warnings,
    sanitizedAction: cleanedAction,
    removedDrift,
  };
}

// ─── Risk scoring (0-100, higher = riskier) ─────────────────────────

export function calculateContinuityRisk({
  bible = {},
  directorState = {},
  action = '',
  model = 'wan-2.2',
  motionStrength = 0.6,
  durationPerShot = 5,
  hasHeroImage = false,
  shotIndex = 0,
} = {}) {
  let score = 0;
  const warnings = [];

  // 1. Drift words. sanitizeShotAction returns { cleaned, removed }
  // — alias here for clarity AND to fix the previous typo
  // (`removedDrift` was undefined, threw on `.length`).
  const { removed: removedDrift = [] } = sanitizeShotAction(action || '');
  if (removedDrift.length) {
    score += 25 + (removedDrift.length - 1) * 5;
    warnings.push(`drift words detected: ${removedDrift.join(', ')}`);
  }

  // 2. Action length — too long for the duration
  const wordCount = (action || '').trim().split(/\s+/).filter(Boolean).length;
  const wordsPerSecond = wordCount / Math.max(1, durationPerShot);
  if (wordsPerSecond > 6) {
    score += 15;
    warnings.push(`action may be too complex for ${durationPerShot}s (${wordCount} words)`);
  }

  // 3. Model fit
  const modelDef = CONTINUITY_MODEL_DEFAULTS[model];
  if (modelDef && durationPerShot > modelDef.maxRecommendedShotSeconds) {
    score += 10;
    warnings.push(`${durationPerShot}s exceeds ${model}'s recommended ${modelDef.maxRecommendedShotSeconds}s — continuity may slip`);
  }
  if (model === 'ltx-video' || model === 'ltx-distilled') {
    score += 15;
    warnings.push('LTX is fast but weaker for multi-shot continuity — Wan 2.1 I2V 14B / Hunyuan recommended');
  }

  // 4. Motion strength
  if (motionStrength > 0.65) {
    score += 20;
    warnings.push(`motionStrength ${motionStrength} is high — identity can mutate`);
  } else if (motionStrength > 0.55) {
    score += 8;
  }

  // 5. Hero image missing on shot 0
  if (shotIndex === 0 && !hasHeroImage) {
    score += 12;
    warnings.push('no hero image — shot 1 will T2V, may drift from master prompt');
  }

  // 6. Bible completeness
  const bibleFilled = ['subject', 'wardrobe', 'environment', 'lighting', 'camera', 'palette']
    .filter(k => typeof bible?.[k] === 'string' && bible[k].trim()).length;
  if (bibleFilled < 3) {
    score += 15;
    warnings.push(`bible only has ${bibleFilled}/6 fields filled — continuity weak`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 45 ? 'risky' : score >= 20 ? 'medium' : 'safe';
  return { score, level, warnings };
}

// ─── Multi-frame extraction (§7) ────────────────────────────────────

// Extracts 5 candidate frames spread across the last 1 second of the
// completed clip. Returns an array of { time, framePath, dataUrl } so
// the chain (or a future scorer) can pick the best one.
//
// The CURRENT chooser is naive — picks the frame at ~-0.4s which is
// almost always sharper than the literal final frame (which often
// has model-tail mutation). Future: blur scoring via OpenCV.
const CANDIDATE_OFFSETS_SEC = [0.2, 0.35, 0.5, 0.7, 0.9];   // measured from end

export async function extractContinuityFrames(mp4Path, tmpDir) {
  // Probe duration so we don't ask ffmpeg for a time past the start.
  const probeOut = await new Promise((resolve, reject) => {
    let buf = '';
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      mp4Path,
    ]);
    proc.stdout.on('data', d => { buf += d.toString(); });
    proc.on('close', code => code === 0 ? resolve(buf.trim()) : reject(new Error(`ffprobe exit ${code}`)));
    proc.on('error', reject);
  }).catch(() => '0');
  const duration = parseFloat(probeOut) || 0;
  const frames = [];
  for (const offset of CANDIDATE_OFFSETS_SEC) {
    if (duration > 0 && offset >= duration) continue;
    const seekFromEnd = duration > 0 ? Math.max(0, duration - offset) : null;
    const framePath = path.join(tmpDir, `cand-${offset.toString().replace('.', '_')}.jpg`);
    try {
      await new Promise((resolve, reject) => {
        const args = duration > 0
          ? ['-y', '-ss', String(seekFromEnd), '-i', mp4Path, '-frames:v', '1', '-q:v', '2', framePath]
          : ['-y', '-sseof', `-${offset}`, '-i', mp4Path, '-frames:v', '1', '-q:v', '2', framePath];
        const proc = spawn('ffmpeg', args);
        proc.on('error', reject);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      });
      const buf = await fs.readFile(framePath);
      frames.push({ time: offset, framePath, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` });
    } catch (err) {
      // single candidate failing is non-fatal; we still have the others
    }
  }
  return frames;
}

// Pick the "safest" continuity frame. Heuristic for now: prefer the
// frame at ~-0.4s (mid-late, past most model tail mutation, before
// the literal final frame). Falls back to whatever's available.
export function chooseContinuityFrame(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  // Find frame closest to 0.4s from end.
  const target = 0.4;
  let best = frames[0]; let bestDist = Math.abs(best.time - target);
  for (const f of frames) {
    const d = Math.abs(f.time - target);
    if (d < bestDist) { best = f; bestDist = d; }
  }
  return best;
}

// Convenience: full pipeline for the chain — extract + choose, returns
// { dataUrl, time, allFrames }. Cleans up its temp dir.
export async function extractAndChooseContinuityFrame(mp4Path) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cinema-cont-'));
  try {
    const frames = await extractContinuityFrames(mp4Path, tmpRoot);
    const chosen = chooseContinuityFrame(frames);
    return chosen
      ? { dataUrl: chosen.dataUrl, time: chosen.time, candidateCount: frames.length }
      : { dataUrl: null, time: null, candidateCount: 0 };
  } finally {
    fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}
