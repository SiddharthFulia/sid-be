// Server-Sent Events (SSE) hub — per-job event streaming so the FE stops
// polling `GET /api/*/status/:id` every 1.5-4 seconds.
//
// Design:
//   · One Map<jobId, Set<res>> shared across the process.
//   · Any controller that updates a job's state calls broadcastJobEvent(jobId, event).
//   · An HTTP GET /api/events/job/:jobId opens an SSE stream, registers the
//     res, and pipes every future broadcast for that jobId as a discrete event.
//   · Client disconnect (`req.on('close')`) removes the res from the set;
//     when the set empties we drop the jobId key so the Map stays lean.
//
// Why SSE (not WebSockets):
//   · Existing endpoints already return JSON — SSE is a one-line addition,
//     no protocol upgrade dance, works through every proxy Nginx cares about.
//   · One-way BE → FE is exactly what we need. WebSockets add half-duplex
//     handshake overhead for zero benefit.
//   · Native `EventSource` reconnects on network blips with no client code.
//
// Why not WebSocket-per-job:
//   · We'd hit CloudAMQP's per-connection budget on a heavy demo. SSE reuses
//     the existing HTTP keep-alive pool.

import logger from '../../helpers/logger.js';

/** @type {Map<string, Set<import('http').ServerResponse>>} */
const subscribers = new Map();

/**
 * Register an SSE response for a given jobId. Auto-cleans on close.
 * Returns an unregister function callers can invoke on their own timers.
 */
export function registerSubscriber(jobId, res) {
  if (!jobId || !res) return () => {};
  const key = String(jobId);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(res);

  const unregister = () => {
    const s = subscribers.get(key);
    if (!s) return;
    s.delete(res);
    if (s.size === 0) subscribers.delete(key);
  };
  res.on('close', unregister);
  res.on('finish', unregister);
  return unregister;
}

/**
 * Broadcast an event to every subscriber for a given jobId. `type` shows up
 * as the SSE `event:` frame so the FE can `addEventListener(type, …)`.
 * `data` becomes the `data:` JSON payload.
 */
export function broadcastJobEvent(jobId, type, data) {
  if (!jobId || !type) return;
  const set = subscribers.get(String(jobId));
  if (!set || set.size === 0) return;
  const payload = safeStringify(data);
  const frame = `event: ${type}\ndata: ${payload}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch (err) {
      logger.warn(`sseHub write failed for job=${jobId} (subscriber will be reaped)`);
      set.delete(res);
      try { res.end(); } catch {}
    }
  }
  if (set.size === 0) subscribers.delete(String(jobId));
}

/** Admin/debug — how many streams are alive right now? */
export function getHubStats() {
  let subs = 0;
  for (const set of subscribers.values()) subs += set.size;
  return { jobs: subscribers.size, subscribers: subs };
}

function safeStringify(data) {
  try { return JSON.stringify(data ?? null); }
  catch { return JSON.stringify({ error: 'unserializable event data' }); }
}
