import { WORKER_WAKE_URL, WORKER_WAKE_TOKEN } from '../../helpers/constants.js';
import { isTelegramConfigured, sendTelegramWakeAlert } from './telegramNotify.js';
import logger from '../../helpers/logger.js';

let lastWakeAttempt = 0;
const COOLDOWN_MS = 60 * 1000;

async function fireWebhook(context) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (WORKER_WAKE_TOKEN) headers['Authorization'] = `Bearer ${WORKER_WAKE_TOKEN}`;
    const res = await fetch(WORKER_WAKE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: 'wake_worker', ts: new Date().toISOString(), ...context }),
      signal: AbortSignal.timeout(8000),
    });
    return { method: 'webhook', sent: res.ok, status: res.status };
  } catch (err) {
    return { method: 'webhook', sent: false, error: err.message };
  }
}

export async function tryWakeWorker(context = {}) {
  const results = [];

  const hasTelegram = isTelegramConfigured();
  const hasWebhook = !!WORKER_WAKE_URL;
  if (!hasTelegram && !hasWebhook) {
    return { attempted: false, reason: 'no wake methods configured' };
  }

  const now = Date.now();
  if (now - lastWakeAttempt < COOLDOWN_MS) {
    return { attempted: false, reason: 'cooldown' };
  }
  lastWakeAttempt = now;

  if (hasTelegram) {
    const r = await sendTelegramWakeAlert(context);
    results.push({ method: 'telegram', ...r });
  }
  if (hasWebhook) {
    results.push(await fireWebhook(context));
  }

  logger.info(`Wake attempt: ${results.map(r => `${r.method}=${r.sent ? 'ok' : 'fail'}`).join(', ')}`);
  return { attempted: true, methods: results };
}
