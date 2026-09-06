// System Oracle controllers.
//
// Three endpoints, all wired under /api/agents/system/* in routes/agents/index.js:
//
//   POST /api/agents/system         → non-streaming JSON answer (delegates to
//                                     the pf-agents registry so
//                                     /api/agents/system-oracle also works)
//   POST /api/agents/system/stream  → SSE stream of Groq tokens as they arrive,
//                                     terminated by a context-summary event.
//                                     Uses Groq's `stream: true` mode directly
//                                     since services/groq.js hardcodes false.
//   GET  /api/agents/system/context → the raw context bundle. No LLM call. For
//                                     the FE "what I know right now" panel and
//                                     for debugging the collector.
//
// All three are vault-gated at the route layer.

import { randomUUID } from 'crypto';
import { buildSystemContext, contextBytes } from '../../services/agents/tools/systemContext.js';
import { getAgent } from '../../services/agents/index.js';
import { validateInput } from '../../services/agents/baseAgent.js';
import { buildOraclePrompt, resolveModel } from '../../services/agents/systemOracle.js';
import { GROQ_API_KEY } from '../../helpers/constants.js';
import logger from '../../helpers/logger.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Non-streaming JSON handler ─────────────────────────────────
// Thin wrapper that dispatches to the registered agent so the response shape
// mirrors POST /api/agents/system-oracle exactly. The dedicated route is a
// convenience so the FE doesn't have to know the agent's id.
export async function postSystemOracle(req, res) {
  const agent = getAgent('system-oracle');
  if (!agent) {
    return res.status(500).json({ error: 'system-oracle agent not registered' });
  }
  const errors = validateInput(req.body, agent.spec.input);
  if (errors.length) {
    return res.status(400).json({ error: 'invalid input', details: errors });
  }
  const requestId = randomUUID();
  const ctx = { requestId, logger };
  try {
    const started = Date.now();
    const result = await agent.run(req.body, ctx);
    return res.json({
      requestId,
      agentId: 'system-oracle',
      durationMs: Date.now() - started,
      result,
    });
  } catch (err) {
    const status = err.status || 500;
    logger.error(`system-oracle failed`, { requestId, error: err.message });
    return res.status(status).json({
      requestId,
      agentId: 'system-oracle',
      error: err.message || 'System Oracle failed',
    });
  }
}

// ── Context-only handler (GET) ────────────────────────────────
// Assembles the bundle and returns it verbatim, plus a `contextSize` byte
// count so the FE can display "sending 42 KB to the LLM" telemetry. No Groq
// call — cheap enough that the FE dashboard can call this on every "what do
// you know?" tab open.
export async function getSystemOracleContext(_req, res) {
  try {
    const bundle = await buildSystemContext();
    return res.json({
      context: bundle,
      contextSize: contextBytes(bundle),
    });
  } catch (err) {
    logger.error('system-oracle context failed', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── SSE streaming handler ─────────────────────────────────────
// Streams Groq tokens as they arrive using Server-Sent Events. Body: same
// as the non-streaming variant — { question, model? }.
//
// Event stream:
//   event: meta            — { requestId, model, contextSize, assembledAt }
//   event: token           — { text }             (many of these)
//   event: context-summary — { tables, routes, queues, crons, tokensUsed }
//   event: done            — {}                   (terminal, then res.end())
//   event: error           — { message }          (on failure)
//
// The FE listens for `token` events and appends to a growing string; when
// it sees `done` it stops the typing indicator.
//
// We intentionally do NOT reuse services/groq.js here — that helper is
// hardcoded to stream: false. Duplicating the fetch call is cheaper than
// refactoring the whole helper for a single new caller.
export async function postSystemOracleStream(req, res) {
  const question = String(req.body?.question || '').trim();
  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (!GROQ_API_KEY) {
    return res.status(503).json({ error: 'Groq API key not configured' });
  }

  const requestId = randomUUID();
  const model = resolveModel(req.body);

  // SSE headers. `X-Accel-Buffering: no` disables Nginx buffering so events
  // land at the client the moment we flush, not after a 4KB chunk fills.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected — nothing to do, the finally cleanup below runs.
    }
  };

  let bundle = null;
  let upstream = null;
  try {
    bundle = await buildSystemContext();
    const system = buildOraclePrompt(bundle);

    send('meta', {
      requestId,
      model,
      contextSize: contextBytes(bundle),
      assembledAt: bundle.assembledAt,
    });

    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: question },
        ],
        max_tokens:  1500,
        temperature: 0.2,
        stream:      true,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      send('error', { message: `Groq HTTP ${upstream.status}: ${errText.slice(0, 300)}` });
      send('done', {});
      return res.end();
    }

    // Groq/OpenAI-style SSE stream: lines of `data: {...}` separated by
    // blank lines, terminated by `data: [DONE]`. We buffer partial lines
    // because a single chunk may split a JSON payload across boundaries.
    let tokensUsed = null;
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    // Detect client disconnect early — no point burning Groq quota if the
    // FE tab was closed mid-stream.
    let clientClosed = false;
    req.on('close', () => { clientClosed = true; });

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (clientClosed) {
        try { await reader.cancel(); } catch {}
        break;
      }
      buf += decoder.decode(value, { stream: true });

      // Split on the SSE record boundary `\n\n`. Leave the trailing partial
      // record in the buffer for the next iteration.
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const record = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        // Each record is one or more `data: ...` lines. Some Groq responses
        // include an empty `data: ` line at the start of a chunk — skip
        // silently.
        for (const line of record.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') { buf = ''; break; }
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) send('token', { text: delta });
            if (chunk.usage?.total_tokens) tokensUsed = chunk.usage.total_tokens;
          } catch {
            // Malformed chunk — drop and continue. Groq occasionally
            // sends the usage payload as its own chunk after [DONE].
          }
        }
      }
    }

    // Final summary — same telemetry the non-streaming handler returns in
    // its result envelope, so the FE can render "assembled at / tokens used"
    // once the typing finishes.
    send('context-summary', {
      tables:      bundle.tables?.count       || 0,
      routes:      bundle.routes?.count       || 0,
      queues:      bundle.queues?.count       || 0,
      crons:       bundle.crons?.count        || 0,
      tokensUsed,
      assembledAt: bundle.assembledAt,
      contextSize: contextBytes(bundle),
      model,
    });
    send('done', {});
    return res.end();
  } catch (err) {
    logger.error('system-oracle stream failed', err.message);
    send('error', { message: err.message || 'stream failed' });
    send('done', {});
    try { return res.end(); } catch { /* already closed */ }
  }
}
