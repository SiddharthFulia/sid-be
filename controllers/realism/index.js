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
take a short, plain-English prompt and rewrite it into a richly
cinematic prompt that will trigger photographic realism instead of
generic "AI video" output.

You MUST respond with a single JSON object and nothing else:

{
  "enriched": "ONE long descriptive paragraph (180-260 words) ready to paste into a video model. Preserve the user's subject + action faithfully. Layer in lens, lighting, grain, color grade, camera motion, atmospheric detail, micro-realism cues (skin pores, natural eye reflections, motion blur, parallax, depth haze). Avoid hype words like 'cinematic', 'epic', '8K' — instead, name the specific physical thing (e.g. 'specular highlights on damp asphalt' not 'cinematic look').",
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
  const base     = String(req.body?.base || '').slice(0, 600).trim();
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

  let parsed = null;
  try {
    const { reply } = await chatGroq(userMsg, [], 'llama-3.3-70b', {
      system:      SYSTEM_PROMPT,
      temperature: 0.55,
      maxTokens:   900,
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
