// /api/realism/* — sandbox for the "Seedance-grade realism" pipeline.
//
// The whole point of this controller is to NOT rewrite anything that
// already works in /api/ai-video/*. Instead we add the missing piece:
// turn a plain-English prompt into a fully cinematic prompt that the
// downstream image + I2V models can actually render at a realistic
// quality. The user then submits the enriched prompt to the existing
// /api/ai-video/generate endpoint and gets a real video back.
//
// Endpoints
//   POST /api/realism/enrich-prompt   { base, lens, lighting, grain, tone, motion }
//                                     → { enriched, negative, breakdown }
//
// Why a separate route + controller: keeps the experiment isolated
// from production AI Video flows. If we discover the enriched prompts
// nuke quality in some cases, we can iterate here without affecting
// the main lane.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import { chatGroq } from '../../services/groq.js';

// Style libraries — kept small + concrete so users can pick without
// being overwhelmed. Each entry is a sentence fragment that gets
// dropped into the enriched prompt verbatim if Groq can't reach
// (fallback synthesis).
const LENSES = {
  '35mm-anamorphic': '35mm anamorphic lens · oval bokeh · subtle horizontal lens flares',
  '50mm-prime':       '50mm prime lens · natural perspective · shallow depth of field',
  '85mm-portrait':    '85mm portrait lens · compressed background · creamy bokeh',
  'wide-24mm':        '24mm wide-angle · expansive cinematic framing · slight barrel distortion',
  'macro':            'macro lens · intimate detail · extremely shallow focus',
};

const LIGHTING = {
  'golden-hour':      'golden hour · low warm sunlight · long shadows · rim light on skin',
  'overcast-natural': 'overcast diffuse daylight · soft natural skin tones · no hard shadows',
  'practical-night':  'practical night lighting · warm tungsten + cool ambient mix · bokeh of street lamps',
  'studio-key-fill':  'three-point studio lighting · soft key · subtle fill · rim · clean black background',
  'volumetric':       'volumetric god rays through atmosphere · particles drifting in light · dust motes',
  'neon-noir':        'neon noir · saturated cyan + magenta rim light · wet reflective surfaces',
};

const GRAIN = {
  'clean':       'modern digital cinema · clean grain · pristine color',
  'kodak-vision3':'Kodak Vision3 500T film grain · organic texture · subtle highlights bloom',
  'super-16':    'Super 16mm film grain · slightly coarse texture · vintage tonality',
  'super-8':     'heavy Super 8 grain · soft halation · nostalgic warmth',
};

const TONE = {
  'natural':    'natural color grade · accurate skin tones · neutral whites',
  'warm-teal':  'cinematic teal & orange grade · warm skin · cool shadows',
  'desaturated':'desaturated palette · muted greens · soft pastel highlights',
  'bleach':     'bleach-bypass look · crushed blacks · raised mid-tones · pale skin',
};

const MOTION = {
  'subtle':     'subtle handheld micro-motion · faint camera breathing · believable physical weight',
  'slow-push':  'slow dolly push in · smooth motion · cinematic camera move',
  'orbit':      'graceful orbital arc around the subject · steady gimbal feel',
  'static':     'locked-off tripod shot · perfectly still framing · let subject motion drive the frame',
};

// The system prompt is where the real magic happens — Groq is told to
// preserve the user's *intent* but layer in the cinematic stack that
// open-source video models need to render at studio quality. Output
// strictly JSON so the FE can pull each section cleanly.
const SYSTEM_PROMPT = `You are a senior AI cinematographer specialising in image-to-video
generation with Wan, Hunyuan, LTX, and similar models. Your job is to
take a plain-English prompt of ANY length (from one sentence to several
thousand words) and rewrite it into a richly cinematic prompt that will
trigger photographic realism instead of generic "AI video" output.

You MUST respond with a single JSON object and nothing else:

{
  "enriched": "A faithful, photographically-detailed rewrite of the user's prompt.

LENGTH SCALING RULES (critical):
  - If the user's input is under 60 words, output 150-250 words.
  - If the input is 60-300 words, output ~1.5x the input length.
  - If the input is 300-1500 words, output a length within ±20% of the input. Never cut content. Reorganise + expand each beat into physically-described imagery.
  - If the input is 1500+ words, preserve EVERY scene beat, character, prop, and line of action the user wrote. Add cinematic detail to each. Output can match or modestly exceed the input length.

CONTENT RULES:
  - Preserve every subject, action, location, line of dialogue, and emotional beat from the user's input. Do not summarise.
  - Layer in lens, lighting, grain, color grade, camera motion, atmospheric detail, micro-realism cues (skin pores, natural eye reflections, motion blur, parallax, depth haze, sub-surface scattering, garment physics).
  - Name the specific physical thing instead of buzzwords: 'specular highlights on damp asphalt' not 'cinematic look'; 'Kodak Vision3 500T halation in the highlights' not 'film grain'.
  - For multi-scene prompts, structure the rewrite as a sequence of beats. Use line breaks between scenes.",
  "negative": "ONE comma-separated negative prompt list of artifacts to suppress: low quality, plastic skin, waxy faces, melted hands, jittery limbs, extra fingers, deformed eyes, frame interpolation artefacts, watermark, text overlays, cartoon, anime, painting, illustration, oversaturated colors.",
  "breakdown": {
    "lens":     "<one short phrase>",
    "lighting": "<one short phrase>",
    "grain":    "<one short phrase>",
    "tone":     "<one short phrase>",
    "motion":   "<one short phrase>"
  }
}

The user will also pass explicit overrides for lens/lighting/grain/tone/motion. Honour them faithfully when present — don't substitute your own choices.

No markdown. No code fences. JSON only.`;

function fallbackEnrich({ base, lens, lighting, grain, tone, motion }) {
  const parts = [
    base.trim(),
    LENSES[lens]      || LENSES['35mm-anamorphic'],
    LIGHTING[lighting] || LIGHTING['golden-hour'],
    GRAIN[grain]      || GRAIN['kodak-vision3'],
    TONE[tone]        || TONE['warm-teal'],
    MOTION[motion]    || MOTION['subtle'],
    'natural skin texture · visible pores · subtle micro-expressions',
    'shallow depth of field · accurate motion blur · global illumination',
    'realistic eye reflections · physically plausible hair · cloth physics',
    'practical lighting · high dynamic range · soft falloff',
  ];
  return {
    enriched: parts.join(' · '),
    negative: 'low quality, plastic skin, waxy faces, melted hands, jittery limbs, extra fingers, deformed eyes, watermark, text overlay, cartoon, anime, painting, illustration, oversaturated, blurry, low resolution',
    breakdown: {
      lens:     LENSES[lens]      || LENSES['35mm-anamorphic'],
      lighting: LIGHTING[lighting] || LIGHTING['golden-hour'],
      grain:    GRAIN[grain]      || GRAIN['kodak-vision3'],
      tone:     TONE[tone]        || TONE['warm-teal'],
      motion:   MOTION[motion]    || MOTION['subtle'],
    },
  };
}

export const postEnrichPrompt = async (req, res) => {
  // 5 000 chars accommodates ~700 plain-English words or a fairly
  // detailed multi-shot brief. Anything longer almost certainly wants
  // to be split into separate clips anyway.
  const base = String(req.body?.base || '').slice(0, 5000).trim();
  if (!base) return error(res, 'base prompt required', 400);
  const lens     = String(req.body?.lens     || '');
  const lighting = String(req.body?.lighting || '');
  const grain    = String(req.body?.grain    || '');
  const tone     = String(req.body?.tone     || '');
  const motion   = String(req.body?.motion   || '');

  const userMsg =
    `Base prompt: "${base}"\n` +
    `Overrides (use these if not empty):\n` +
    `  lens:     ${LENSES[lens]      || '—'}\n` +
    `  lighting: ${LIGHTING[lighting] || '—'}\n` +
    `  grain:    ${GRAIN[grain]      || '—'}\n` +
    `  tone:     ${TONE[tone]        || '—'}\n` +
    `  motion:   ${MOTION[motion]    || '—'}\n\n` +
    `Return the JSON now.`;

  // Scale Groq's output budget to the input size so long briefs come
  // back fully expanded instead of truncated mid-paragraph. Rough
  // ratio: 1 token ≈ 4 chars; ~2x the input chars in tokens covers
  // the expansion target with comfortable headroom. Cap at 6 000 so
  // we don't blow the model's per-request budget for tiny inputs.
  const targetTokens = Math.min(6000, Math.max(800, Math.ceil(base.length * 0.7)));

  let parsed = null;
  try {
    const { reply } = await chatGroq(userMsg, [], 'llama-3.3-70b', {
      system:      SYSTEM_PROMPT,
      temperature: 0.55,
      maxTokens:   targetTokens,
    });
    const cleaned = String(reply || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`[realism/enrich] Groq parse failed: ${err.message}; using fallback`);
  }

  if (!parsed?.enriched || typeof parsed.enriched !== 'string') {
    parsed = fallbackEnrich({ base, lens, lighting, grain, tone, motion });
  }

  return success(res, parsed);
};

// Tiny side endpoint so the FE can render the catalog cards without
// hardcoding the strings — keeps the lists in one place.
export const getRealismPresets = (_req, res) => {
  return success(res, {
    lens:     Object.entries(LENSES).map(([key, label])   => ({ key, label })),
    lighting: Object.entries(LIGHTING).map(([key, label]) => ({ key, label })),
    grain:    Object.entries(GRAIN).map(([key, label])    => ({ key, label })),
    tone:     Object.entries(TONE).map(([key, label])     => ({ key, label })),
    motion:   Object.entries(MOTION).map(([key, label])   => ({ key, label })),
  });
};

// ─── Local library for realism renders ───────────────────────────
// Mirrors /api/edit/* exactly — same on-disk layout + range stream
// + lazy poster. The FE calls saveFromUrl after a job completes
// (the Cloudinary URL is generated by the worker callback); we
// stream the bytes down to data/realism-library/<id>.mp4 and write
// a sidecar JSON with title / model / steps / resolution / size /
// vault tag.

const ROOT    = process.cwd();
const LIB_DIR = path.join(ROOT, 'data', 'realism-library');
fs.mkdirSync(LIB_DIR, { recursive: true });

function sidecarPath(id) { return path.join(LIB_DIR, `${id}.json`); }
function videoPath(id)   { return path.join(LIB_DIR, `${id}.mp4`); }
function posterPath(id)  { return path.join(LIB_DIR, `${id}.jpg`); }
const ID_RE = /^[a-f0-9]{16}$/i;

function readSidecar(id) {
  try { return JSON.parse(fs.readFileSync(sidecarPath(id), 'utf8')); } catch { return null; }
}
function writeSidecar(id, data) {
  try { fs.writeFileSync(sidecarPath(id), JSON.stringify(data)); }
  catch (e) { logger.warn(`[realism/sidecar] ${id}: ${e.message}`); }
}

// POST /api/realism/save-from-url   { url, title, model, resolution, steps, jobId }
// Streams the remote video down to local disk + writes a sidecar.
// Returns the saved row (with our internal id + local URL).
export const postSaveFromUrl = async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return error(res, 'url required', 400);

  const id    = crypto.randomBytes(8).toString('hex');
  const dest  = videoPath(id);
  const title = String(req.body?.title || 'Untitled realism render').slice(0, 160);
  const model = String(req.body?.model || '').slice(0, 60);
  const resolution = String(req.body?.resolution || '').slice(0, 20);
  const steps = parseInt(req.body?.steps, 10) || null;
  const sourceJobId = String(req.body?.jobId || '').slice(0, 80);
  const vault = req.vault?.unlocked ? 1 : 0;

  try {
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) throw new Error(`upstream ${fetchRes.status}`);
    await pipeline(Readable.fromWeb(fetchRes.body), fs.createWriteStream(dest));
    const stat = fs.statSync(dest);
    const meta = {
      id, ext: '.mp4',
      title, model, resolution, steps, sourceJobId,
      bytes: stat.size,
      vault,
      createdAt: new Date().toISOString(),
    };
    writeSidecar(id, meta);
    logger.info(`[realism/save-from-url] ${id} · ${title} · ${(stat.size / (1024 * 1024)).toFixed(1)} MB`);
    return success(res, {
      ...meta,
      url:    `/api/realism/file/${id}.mp4`,
      poster: `/api/realism/poster/${id}.jpg`,
    });
  } catch (e) {
    try { fs.unlinkSync(dest); } catch (_) {}
    logger.error(`[realism/save-from-url] ${id} failed: ${e.message}`);
    return error(res, e.message, 502);
  }
};

// GET /api/realism/list  — vault-aware
export const getRealismList = (req, res) => {
  const isVault = !!req.vault?.unlocked;
  const items = fs.readdirSync(LIB_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => readSidecar(path.parse(n).name))
    .filter((m) => !!m && (isVault || !m.vault))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map((m) => ({
      ...m,
      url:    `/api/realism/file/${m.id}.mp4`,
      poster: `/api/realism/poster/${m.id}.jpg`,
    }));
  return success(res, { items, count: items.length, vaultUnlocked: isVault });
};

// GET /api/realism/file/:name      Range streaming + vault check
export const getRealismFile = (req, res) => {
  const raw = String(req.params.name || '');
  if (!/^[a-f0-9]{16}\.mp4$/i.test(raw)) return error(res, 'Bad id', 400);
  const id  = path.parse(raw).name;
  const fp  = videoPath(id);
  if (!fs.existsSync(fp)) return error(res, 'Not found', 404);
  const meta = readSidecar(id);
  if (meta?.vault && !req.vault?.unlocked) return error(res, 'Vault required', 401);

  const stat = fs.statSync(fp);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', meta?.vault ? 'private, max-age=300' : 'public, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${raw}"`);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end   = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(fp, { start, end }).pipe(res);
    }
  }
  fs.createReadStream(fp).pipe(res);
};

// GET /api/realism/poster/:name    lazy 480-wide thumb
export const getRealismPoster = async (req, res) => {
  const raw = String(req.params.name || '');
  if (!/^[a-f0-9]{16}\.jpg$/i.test(raw)) return error(res, 'Bad id', 400);
  const id   = path.parse(raw).name;
  const fp   = posterPath(id);
  if (!fs.existsSync(fp)) {
    const src = videoPath(id);
    if (!fs.existsSync(src)) return error(res, 'Not found', 404);
    const meta = readSidecar(id);
    if (meta?.vault && !req.vault?.unlocked) return error(res, 'Vault required', 401);
    try {
      await new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', [
          '-y', '-ss', '00:00:01', '-i', src,
          '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', fp,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.slice(-200))));
      });
    } catch (e) {
      return error(res, 'Poster extraction failed', 500);
    }
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(fp).pipe(res);
};

// DELETE /api/realism/:id   vault-required
export const deleteRealism = (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return error(res, 'Bad id', 400);
  const fp = videoPath(id);
  if (!fs.existsSync(fp) && !fs.existsSync(sidecarPath(id))) return error(res, 'Not found', 404);
  try {
    try { fs.unlinkSync(fp); } catch (_) {}
    try { fs.unlinkSync(sidecarPath(id)); } catch (_) {}
    try { fs.unlinkSync(posterPath(id));  } catch (_) {}
  } catch (e) { return error(res, e.message, 500); }
  return success(res, { id, deleted: true });
};
