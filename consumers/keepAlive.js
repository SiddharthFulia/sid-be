// keep_alive queue handler.
//
// Registered by consumers/index.js. Runs on every incoming message: probes
// two internal HTTP endpoints and records the outcome to SQLite so the
// admin panel can render the history.

import { recordKeepAliveRun } from '../services/keepAlive/history.js';

const HEALTH_BASE = process.env.KEEP_ALIVE_BASE || `http://127.0.0.1:${process.env.PORT || 4001}`;
const PROBES = ['/api/health', '/api/stats'];

async function runHealthProbes() {
  const out = [];
  for (const p of PROBES) {
    const started = Date.now();
    try {
      const res = await fetch(`${HEALTH_BASE}${p}`, {
        headers: { accept: 'application/json' },
        signal:  AbortSignal.timeout(8000),
      });
      out.push({ path: p, status: res.status, ok: res.ok, durationMs: Date.now() - started });
    } catch (err) {
      out.push({ path: p, status: 0, ok: false, durationMs: Date.now() - started, error: err.message });
    }
  }
  return out;
}

export default {
  queue:    'keep_alive',
  dlx:      'keep_alive.dlx',
  failed:   'keep_alive_failed_queue',
  prefetch: 1,

  async handle(payload) {
    const startedAt = new Date().toISOString();
    const probes = await runHealthProbes();
    const finishedAt = new Date().toISOString();
    recordKeepAliveRun({
      requestId:   payload.requestId || `ka-${Date.now()}`,
      reason:      payload.reason || 'unknown',
      triggeredAt: payload.triggeredAt || null,
      startedAt,
      finishedAt,
      probes,
      ok:          probes.every((p) => p.ok),
    });
  },
};
