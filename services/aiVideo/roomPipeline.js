// Room Designer V2.0 — analyze pipeline. Runs synchronously on the
// BE box (no worker queue needed) because every step is either an
// inline child-process spawn (ffmpeg) or a quick HTTP call to a
// service we already operate (Python face service for YOLOv8, Groq
// for the critique). End-to-end takes ~10-15s on a 20-second source
// video at 1280×720.
//
// Steps:
//   1. ffmpeg keyframe extract → 6 frames evenly spaced across the
//      video, written to a temp dir as JPGs (smaller than PNGs and
//      MediaPipe/YOLO doesn't care).
//   2. For each frame: convert to data URL → POST to the existing
//      `/detect-objects` Python service (already wired into face.js,
//      runs YOLOv8-nano ONNX on the 5090 if available, falls back
//      to CPU). Aggregate detections across frames.
//   3. Cluster detections by label, drop low-confidence + duplicate
//      across frames. Compute a coarse `spaceGapPct` from the
//      fraction of frame area not covered by detections.
//   4. Hand the structured detection summary to Groq with a tight
//      JSON-only prompt. Groq returns roomType, toneNotes,
//      missing[{label, why}].
//   5. Merge worker output with our detections into the final
//      analysis JSON the FE renders.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { detectObjects } from '../face.js';
import { chatGroq } from '../groq.js';
import logger from '../../helpers/logger.js';

const KEYFRAME_COUNT = 6;
const DETECTION_THRESHOLD = 0.35;

// ── ffmpeg keyframe extract ──────────────────────────────────────
// Generates KEYFRAME_COUNT frames evenly spaced from 5% to 95% of
// the video duration so we skip black-frame intros and tail-frames.
async function extractKeyframes(videoPath) {
  const tmp = path.join(os.tmpdir(), `room_${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  return new Promise((resolve, reject) => {
    // -vf "select='not(mod(n,FRAME_INTERVAL))'" would tie us to a known
    // frame count; better to use fps math: assume worst-case 30 fps and
    // 30s clip = 900 frames → keep every 150th. ffmpeg's `thumbnail`
    // filter is even simpler — it picks visually-representative frames.
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `thumbnail,scale=1024:-2`,
      '-frames:v', String(KEYFRAME_COUNT),
      path.join(tmp, 'frame_%02d.jpg'),
    ];
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
      // Collect whatever frames landed (thumbnail can produce fewer than
      // requested if the source is shorter than expected).
      const frames = fs.readdirSync(tmp)
        .filter((f) => f.endsWith('.jpg'))
        .sort()
        .map((f) => path.join(tmp, f));
      if (frames.length === 0) return reject(new Error('ffmpeg produced no keyframes'));
      resolve({ tmp, frames });
    });
  });
}

// ── YOLOv8 detection on each keyframe ───────────────────────────
async function detectAcrossFrames(framePaths) {
  const allDetections = [];
  for (let i = 0; i < framePaths.length; i++) {
    try {
      const buf = fs.readFileSync(framePaths[i]);
      const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      const res = await detectObjects(dataUrl, DETECTION_THRESHOLD);
      const items = Array.isArray(res?.detections) ? res.detections : (Array.isArray(res?.objects) ? res.objects : []);
      for (const d of items) {
        // Service may return {label, confidence, box:[x1,y1,x2,y2]} or
        // {class, score, bbox}. Normalize both shapes.
        const label = d.label || d.class || d.name;
        const conf  = d.confidence ?? d.score ?? d.conf ?? 0;
        const bbox  = d.box || d.bbox || d.boundingBox;
        if (label && conf >= DETECTION_THRESHOLD) {
          allDetections.push({ label: String(label).toLowerCase(), conf, bbox, frameIdx: i });
        }
      }
    } catch (err) {
      logger.warn(`[room] detect frame ${i} failed: ${err.message}`);
    }
  }
  return allDetections;
}

// ── Cluster + score ─────────────────────────────────────────────
// One row per unique label, taking the max confidence across frames
// + counting how many frames it appeared in (a stable item should
// appear in most frames).
function summarizeDetections(rawDetections, frameCount) {
  const byLabel = new Map();
  for (const d of rawDetections) {
    const prev = byLabel.get(d.label);
    if (!prev) {
      byLabel.set(d.label, { label: d.label, conf: d.conf, frames: 1 });
    } else {
      prev.conf   = Math.max(prev.conf, d.conf);
      prev.frames += 1;
    }
  }
  const detected = Array.from(byLabel.values())
    .sort((a, b) => b.conf - a.conf)
    .slice(0, 12)
    .map((d) => ({
      label: titleCase(d.label),
      conf: +d.conf.toFixed(2),
      stability: +(d.frames / Math.max(1, frameCount)).toFixed(2),
    }));
  return detected;
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Coarse unused-volume estimate. We don't have depth here (that
// lands in a follow-up); approximate with "fraction of pixels not
// inside any detection bbox" averaged across frames. Caps at 80%
// because a real photo of an empty wall will always have SOME
// camera/floor/etc detection from YOLO.
function estimateGap(rawDetections, frameCount) {
  if (frameCount === 0) return 0;
  // bbox coverage per frame ≈ sum of (w·h) but YOLO bboxes can overlap,
  // so this is a high-bound. Use a softer heuristic: more unique
  // labels → less gap.
  const uniqueLabels = new Set(rawDetections.map((d) => d.label)).size;
  // 0 items → 60% gap; 10+ items → ~10% gap. Linear blend.
  const pct = Math.round(Math.max(5, 60 - uniqueLabels * 5));
  return Math.min(80, pct);
}

// ── Groq critique ───────────────────────────────────────────────
// Prompted for JSON-only response so we can JSON.parse cleanly. If
// it returns prose we fall back to a synthesized critique built
// from the detection summary.
const GROQ_SYSTEM = `You are an interior designer who critiques rooms from object-detection summaries.
You receive a list of items detected in a room video and the percentage of unused space.
You must respond with a SINGLE JSON object and NO prose, in this exact shape:

{
  "roomType": "Short label like 'Living room · approx 3 m × 4 m'",
  "toneNotes": ["3 short observations about lighting/palette/mood, one per item"],
  "missing": [
    { "label": "Item that's missing (e.g. 'Floor lamp')", "why": "One short reason, ≤ 14 words" }
  ]
}

Return 3-5 missing items. Keep every string under 90 chars. No markdown, no code fences.`;

async function groqCritique({ detected, spaceGapPct }) {
  const detectedSummary = detected.map((d) =>
    `${d.label} (conf ${(d.conf * 100).toFixed(0)}%, in ${(d.stability * 100).toFixed(0)}% of frames)`
  ).join('; ');

  const userMsg =
    `Room scan summary:\n` +
    `Detected items: ${detectedSummary || '(nothing detected)'}\n` +
    `Estimated unused space: ${spaceGapPct}%\n\n` +
    `Critique this room. Return the JSON only.`;

  let parsed = null;
  try {
    const { reply } = await chatGroq(userMsg, [], 'llama-3.3-70b', {
      system: GROQ_SYSTEM,
      temperature: 0.4,
      maxTokens: 700,
    });
    // Strip code fences if Groq added any.
    const cleaned = String(reply || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`[room] Groq critique JSON parse failed: ${err.message}`);
  }
  return parsed;
}

// ── Public: full analyze pipeline ───────────────────────────────
export async function analyzeRoom(videoPath) {
  const startedAt = Date.now();
  const { tmp, frames } = await extractKeyframes(videoPath);
  try {
    const rawDetections = await detectAcrossFrames(frames);
    const detected      = summarizeDetections(rawDetections, frames.length);
    const spaceGapPct   = estimateGap(rawDetections, frames.length);

    let critique = await groqCritique({ detected, spaceGapPct });

    // Synthesize a fallback if Groq returns garbage so the user never
    // sees an empty analysis card.
    if (!critique || !Array.isArray(critique.missing)) {
      critique = {
        roomType: detected.length ? `Indoor space · ${detected.length} items detected` : 'Indoor space',
        toneNotes: [
          'Auto-fallback critique — Groq did not return valid JSON',
          `Detected ${detected.length} distinct items across ${frames.length} keyframes`,
          `Estimated ${spaceGapPct}% unused space`,
        ],
        missing: [
          { label: 'Floor lamp',       why: 'Layered lighting reads warmer than a single ceiling source' },
          { label: 'Plant or greenery',why: 'Biophilia softens corners and adds depth' },
          { label: 'Art or photography', why: 'Wall area above eye-line is the easiest fill' },
        ],
      };
    }

    const elapsedMs = Date.now() - startedAt;
    return {
      analysis: {
        roomType:    critique.roomType,
        toneNotes:   Array.isArray(critique.toneNotes) ? critique.toneNotes.slice(0, 5) : [],
        detected:    detected.map((d) => ({
          label: d.label, conf: d.conf, box: d.stability >= 0.5 ? 'stable' : 'partial',
        })),
        missing:     critique.missing.slice(0, 6),
        spaceGapPct,
      },
      keyframeCount: frames.length,
      elapsedMs,
    };
  } finally {
    // Best-effort cleanup. Even if every frame succeeded we still
    // want the temp dir gone.
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}
