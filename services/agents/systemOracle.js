// System Oracle agent — Groq-powered Q&A over the live sid-be server state.
//
// On every question, assembles a context bundle (SQLite tables + row counts,
// RabbitMQ queue depths, PM2 processes, cron schedules, uptime + memory,
// mounted routes, env var NAMES, Groq model catalog) and feeds it into a
// Groq LLM as a system prompt. The model answers grounded in what actually
// exists on the box, not what a training-set snapshot said existed.
//
// See tools/systemContext.js for the bundle builder. See
// controllers/agents/systemOracle.js for the SSE-streaming variant + the
// context-only debug endpoint.
//
// SECURITY:
//   · Env values are NEVER included in the bundle — names only.
//   · Table rows are NEVER included — schema + aggregate counts only.
//   · The "vault" auth level in the spec means only the password-holder can
//     hit this; the FE settings dashboard is the intended caller.

import { chatGroq } from '../groq.js';
import { buildSystemContext, contextBytes } from './tools/systemContext.js';

// Default to gpt-oss-120b — this is a reasoning-heavy Q&A workload where
// the extra tokens are worth it. Caller can override via input.model.
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

// Whitelist of models the caller can pick. Anything else falls back to the
// default. Keeps the FE from accidentally driving up cost by asking for a
// model we don't want to expose.
const ALLOWED_MODELS = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
]);

export const spec = {
  id: 'system-oracle',
  purpose: 'Answers operational questions about the sid-be server (processes, queues, tables, crons, uptime, routes) using a live-assembled context bundle fed to Groq.',
  auth: 'vault',
  input: {
    question: 'string',
    model:    'string?',   // optional Groq model override
  },
  output: {
    answer:      'string',
    contextSize: 'number',    // bytes of the JSON context we sent to Groq
    tables:      'number',    // count of DB tables consulted
    routes:      'number',    // count of routes catalogued
    queues:      'number',    // count of live queues seen
    crons:       'number',    // count of cron jobs
    model:       'string',    // actual Groq model that responded
    tokensUsed:  'number?',   // total_tokens from Groq (may be undefined)
    assembledAt: 'string',    // ISO timestamp of the context snapshot
  },
};

/**
 * Build the system prompt that frames the LLM. The bundle is attached as
 * a fenced JSON block so the model treats it as data, not instructions.
 */
export function buildOraclePrompt(bundle) {
  return [
    'You are the System Oracle for sid-be, a Node/Express backend running on Oracle Cloud (Ubuntu ARM, 2 OCPU, 12 GB RAM) behind Nginx + PM2.',
    'You know the current server state from the JSON snapshot below. Answer the user\'s question precisely, in one to three short paragraphs (or a bulleted list when enumerating).',
    '',
    'Ground rules:',
    '- If the answer requires exact numbers (row counts, queue depths, uptime, memory), cite them from the snapshot.',
    '- If the snapshot doesn\'t contain the information, say "the context doesn\'t include this" and stop. Never fabricate.',
    '- The snapshot is a point-in-time capture — the `assembledAt` field is its timestamp. Mention staleness if relevant.',
    '- Env var VALUES are intentionally omitted for security. Only the NAMES are available. Never guess a value.',
    '- Table row contents are intentionally omitted. Only aggregate counts + column names are available. Suggest the caller use the DB Explorer if they need actual rows.',
    '- Be concise. Skip preamble. Answer directly.',
    '',
    'Live server snapshot (JSON):',
    '```json',
    JSON.stringify(bundle, null, 2),
    '```',
  ].join('\n');
}

/**
 * Pick a Groq model name from the caller's input. Falls back to the default
 * when the caller sends an unknown / disallowed value.
 */
export function resolveModel(input) {
  const requested = String(input?.model || '').trim();
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

/**
 * Non-streaming run — returns the answer + telemetry once Groq completes.
 * The SSE-streaming variant lives in the controller and calls
 * `buildSystemContext` + Groq's `stream: true` mode directly (see
 * controllers/agents/systemOracle.js). We can't cleanly reuse `chatGroq`
 * for streaming because it hardcodes stream: false.
 */
export async function run(input, _ctx = {}) {
  const question = String(input?.question || '').trim();
  if (!question) {
    const e = new Error('question is required');
    e.status = 400;
    throw e;
  }

  const model = resolveModel(input);
  const bundle = await buildSystemContext();
  const system = buildOraclePrompt(bundle);

  // chatGroq accepts either a short alias ('llama-3.3-70b') or a full model
  // id. Our whitelist matches Groq's actual ids so we pass through directly.
  const groqRes = await chatGroq(question, [], model, {
    system,
    maxTokens:   1500,
    temperature: 0.2,
  });

  return {
    answer:      String(groqRes?.reply || '').trim(),
    contextSize: contextBytes(bundle),
    tables:      bundle.tables?.count       || 0,
    routes:      bundle.routes?.count       || 0,
    queues:      bundle.queues?.count       || 0,
    crons:       bundle.crons?.count        || 0,
    model:       groqRes?.model || model,
    tokensUsed:  groqRes?.totalTokens ?? null,
    assembledAt: bundle.assembledAt,
  };
}

export { DEFAULT_MODEL, ALLOWED_MODELS };
