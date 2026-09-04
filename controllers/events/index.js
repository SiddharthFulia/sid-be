// HTTP handlers for /api/events/*. Opens SSE streams and delegates to
// services/events/sseHub.js for delivery. No polling anywhere — the res
// object stays open until the client disconnects.

import { registerSubscriber, getHubStats } from '../../services/events/sseHub.js';

const HEARTBEAT_INTERVAL_MS = 25_000; // keep intermediaries from timing out

export function streamJobEvents(req, res) {
  const jobId = String(req.params.jobId || '').trim();
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  // SSE headers. `X-Accel-Buffering: no` disables Nginx's response buffering
  // so events flush immediately instead of being held until the buffer fills.
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Handshake frame — the FE knows the stream is live before any real event.
  res.write(`event: hello\ndata: ${JSON.stringify({ jobId, at: new Date().toISOString() })}\n\n`);

  const unregister = registerSubscriber(jobId, res);

  // Heartbeat: send a comment frame every 25s so proxies keep the connection
  // open. Comments (leading `:`) are ignored by the browser EventSource.
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat ${Date.now()}\n\n`); }
    catch { /* subscriber gone — will be reaped on next real event */ }
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregister();
    try { res.end(); } catch {}
  });
}

export function getEventsStats(req, res) {
  return res.json(getHubStats());
}
