// CloudAMQP / RabbitMQ / LavinMQ management HTTP API helper.
//
// The AMQP protocol itself has no "list all queues" op — channel.checkQueue
// wants a name. To discover every queue dynamically (instead of a hardcoded
// KNOWN_QUEUES whitelist) we call the management HTTP API instead.
//
// URL derivation from RABBITMQ_URL (amqp[s]://user:pass@host[:port]/vhost):
//   scheme  amqps → https, amqp → http
//   host    same host, no port (CloudAMQP proxies HTTPS on 443)
//   path    /api/queues/<url-encoded-vhost>
//   auth    HTTP Basic (user + pass from the AMQP URL)
//
// Cached for 5s so the Settings dashboard's poll loop doesn't hammer the
// management API — that endpoint is rate-limited more aggressively than the
// AMQP publish path on CloudAMQP.

import logger from '../../helpers/logger.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const CACHE_TTL_MS = 5000;

let _cache = { ts: 0, data: null };

function parsedFromEnv() {
  if (!RABBITMQ_URL) return null;
  try {
    const u = new URL(RABBITMQ_URL);
    if (!u.username || !u.hostname) return null;
    const httpScheme = u.protocol === 'amqps:' ? 'https:' : 'http:';
    // Default vhost when the URL path is empty is `/` — CloudAMQP always
    // gives you a named vhost so this fallback is mostly a safety net.
    const rawVhost = decodeURIComponent(u.pathname.replace(/^\//, '') || '/');
    return {
      user:  decodeURIComponent(u.username),
      pass:  decodeURIComponent(u.password || ''),
      host:  u.hostname,
      port:  u.port || '',
      vhost: rawVhost,
      httpScheme,
    };
  } catch (err) {
    logger.error(`managementApi parse error: ${err.message}`);
    return null;
  }
}

function managementBaseUrl(p) {
  const portPart = p.port ? `:${p.port}` : '';
  return `${p.httpScheme}//${p.host}${portPart}`;
}

/**
 * List every queue on the broker. Returns array of
 * { name, messageCount, consumerCount, memory, state } (extra fields
 * dropped so callers don't accidentally rely on management-plugin-specific
 * shapes).
 *
 * Result cached 5s per process.
 */
export async function listAllQueues({ force = false } = {}) {
  if (!force && _cache.data && (Date.now() - _cache.ts) < CACHE_TTL_MS) {
    return _cache.data;
  }
  const p = parsedFromEnv();
  if (!p) return { configured: false, queues: [] };

  const url = `${managementBaseUrl(p)}/api/queues/${encodeURIComponent(p.vhost)}`;
  const auth = `Basic ${Buffer.from(`${p.user}:${p.pass}`).toString('base64')}`;

  try {
    const res = await fetch(url, {
      headers: { authorization: auth, accept: 'application/json' },
      // The management endpoint on CloudAMQP is fine on default keepalive,
      // but we cap generously so a hung request doesn't stall the /queues
      // poll loop. AbortController is the standard shape.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn(`managementApi listAllQueues HTTP ${res.status}`);
      return { configured: true, queues: [], error: `HTTP ${res.status}` };
    }
    const raw = await res.json();
    if (!Array.isArray(raw)) {
      return { configured: true, queues: [], error: 'unexpected shape' };
    }
    const queues = raw.map((q) => ({
      name:          String(q.name || ''),
      messageCount:  Number(q.messages ?? q.message_count ?? 0),
      consumerCount: Number(q.consumers ?? q.consumer_count ?? 0),
      state:         String(q.state || ''),
    }));
    _cache = { ts: Date.now(), data: { configured: true, queues } };
    return _cache.data;
  } catch (err) {
    logger.warn(`managementApi listAllQueues failed: ${err.message}`);
    return { configured: true, queues: [], error: err.message };
  }
}

/** Clear the 5s cache — call after purge so the next fetch shows 0. */
export function invalidateCache() {
  _cache = { ts: 0, data: null };
}
