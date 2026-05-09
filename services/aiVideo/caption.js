// Caption + hashtag generator for AI videos.
//
// Two-stage pipeline:
//   1. Groq (llama-3.1-8b-instant) returns a caption ending in 5 hashtags.
//   2. If the model forgets the hashtags (happens ~30% with the 8B), we
//      synthesize them from the prompt's keywords as a fallback.
//
// Stage 2 means the FE never has to deal with an "empty hashtags" case —
// every caption that comes back from this function ends in 5 hashtags.

import { GROQ_API_KEY } from '../../helpers/constants.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Strong prompt: explicit format example + emphasis on the trailing hashtags.
// llama-3.1-8b honours JSON-shape examples reliably; plain prose instructions
// it ignores half the time.
const SYSTEM_PROMPT = [
  'You write viral Instagram Reel captions for AI-generated videos.',
  'STRICT FORMAT (no exceptions):',
  '  Line 1: 1-2 sentences, with 1-2 emojis.',
  '  Line 2: blank.',
  '  Line 3: exactly 5 lowercase hashtags separated by spaces.',
  '',
  'Example:',
  '  Pandas just had to weigh in 🐼✨',
  '',
  '  #aiart #pandalife #cinematic #viral #aivideo',
  '',
  'Never wrap in quotes. Never explain.',
].join('\n');

// Common AI/video hashtags used as the fallback bank when Groq forgets them.
const FALLBACK_TAGS = [
  '#aivideo', '#aiart', '#cinematic', '#viral', '#reels',
  '#generativeai', '#shorts', '#aigenerated', '#trending',
];

// Pull the most distinctive non-stopword tokens from the user's prompt and
// turn them into hashtags. Used to supplement the FALLBACK_TAGS so each video
// gets *contextual* hashtags even when Groq's output drops them.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'in', 'on', 'at', 'to', 'from', 'for', 'with', 'by', 'and', 'or',
  'as', 'into', 'over', 'under', 'this', 'that', 'these', 'those',
  'cinematic', 'video', 'shot', 'scene',   // dominant prompt filler
]);

function hashtagsFromPrompt(prompt) {
  if (!prompt) return [];
  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w));
  // Dedupe in encounter order
  const seen = new Set();
  const tags = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    tags.push('#' + w);
    if (tags.length >= 3) break;
  }
  return tags;
}

function ensureHashtags(caption, prompt) {
  if (!caption) return null;
  // Are there already at least 3 hashtags? If yes, leave it alone.
  const existing = caption.match(/#\w+/g) || [];
  if (existing.length >= 3) return caption.trim();

  // Build 5 hashtags: prompt-derived first (most relevant), then bank fillers.
  const fromPrompt = hashtagsFromPrompt(prompt);
  const need = 5 - existing.length;
  const filler = FALLBACK_TAGS.filter(t => !existing.includes(t) && !fromPrompt.includes(t));
  const additions = [...fromPrompt, ...filler].slice(0, need);

  // Append on a new line for the standard reel format
  return `${caption.trim()}\n\n${additions.join(' ')}`;
}

export async function generateGroqCaption(prompt) {
  if (!GROQ_API_KEY) return null;
  if (!prompt || typeof prompt !== 'string') return null;

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `Prompt: "${prompt}"` },
        ],
        max_tokens: 220,
        temperature: 0.85,
      }),
    });
    if (!res.ok) return ensureHashtags(`AI-generated · ${prompt.slice(0, 80)}`, prompt);

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    if (!text) return null;

    // Strip surrounding quotes the model sometimes adds despite instructions.
    const cleaned = text.replace(/^["'](.+)["']$/s, '$1').trim();

    // Belt-and-suspenders: append hashtags if Groq forgot.
    return ensureHashtags(cleaned, prompt);
  } catch {
    // Even on outright failure, return SOMETHING with tags so the FE never
    // shows a blank caption.
    return ensureHashtags(`AI-generated · ${prompt.slice(0, 80)}`, prompt);
  }
}
