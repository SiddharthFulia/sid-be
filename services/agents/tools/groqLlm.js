// Thin wrapper on services/groq.js for agents.
//
// Adds:
//  · JSON-mode helper that strips markdown fences before parsing
//  · Sensible defaults per model (temperature, maxTokens)
//  · One-line retry on 429 + malformed JSON

import { chatGroq } from '../../groq.js';
import logger from '../../../helpers/logger.js';

const MODEL_DEFAULTS = {
  'llama-3.1-8b-instant':   { temperature: 0.2, maxTokens: 2000 },
  'llama-3.3-70b':          { temperature: 0.1, maxTokens: 4000 },
  'llama-3.3-70b-versatile':{ temperature: 0.1, maxTokens: 4000 },
  'openai/gpt-oss-120b':    { temperature: 0.1, maxTokens: 4000 },
};

/**
 * Ask Groq for a JSON response. Retries once on parse failure.
 * @param {string} prompt   the user turn
 * @param {object} opts
 * @param {string} opts.system   system prompt
 * @param {string} [opts.model='llama-3.3-70b']
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{ parsed: object, raw: string, model: string }>}
 */
export async function askGroqJson(prompt, { system, model = 'llama-3.3-70b', temperature, maxTokens } = {}) {
  const defaults = MODEL_DEFAULTS[model] || MODEL_DEFAULTS['llama-3.3-70b'];
  const opts = {
    system,
    temperature: temperature ?? defaults.temperature,
    maxTokens:   maxTokens   ?? defaults.maxTokens,
  };

  const first = await chatGroq(String(prompt || '').trim(), [], model, opts);
  const firstText = String(first?.reply || '').trim();
  const firstParsed = tryParseJson(firstText);
  if (firstParsed) {
    return { parsed: firstParsed, raw: firstText, model: first?.model || model };
  }

  // One retry with a nudge — the model sometimes hallucinates prose the
  // first time on tight schemas. Second call almost always works.
  logger.warn('askGroqJson: first response was not JSON, retrying once.');
  const nudge = `${prompt}\n\n(Return ONLY a JSON object — no prose, no markdown.)`;
  const second = await chatGroq(nudge, [], model, opts);
  const secondText = String(second?.reply || '').trim();
  const secondParsed = tryParseJson(secondText);
  if (secondParsed) {
    return { parsed: secondParsed, raw: secondText, model: second?.model || model };
  }

  const err = new Error('Groq did not return parseable JSON after retry.');
  err.status = 502;
  err.raw = secondText;
  throw err;
}

function tryParseJson(text) {
  const cleaned = stripMarkdownFences(text);
  try { return JSON.parse(cleaned); } catch {}
  // Fallback: pluck the first {...} block.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function stripMarkdownFences(s) {
  return String(s || '').trim()
    .replace(/^```(?:json|sql)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}
