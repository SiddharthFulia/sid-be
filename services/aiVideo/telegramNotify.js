import {
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LIGHTNING_STUDIO_URL,
} from '../../helpers/constants.js';
import logger from '../../helpers/logger.js';

const TG_API = 'https://api.telegram.org';

export function isTelegramConfigured() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

function escapeMd(s = '') {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => `\\${m}`);
}

export async function sendTelegramWakeAlert(context = {}) {
  if (!isTelegramConfigured()) return { sent: false, reason: 'not configured' };

  const promptPreview = (context.prompt || '').slice(0, 180);
  const text = [
    '🎬 *AI video request*',
    '',
    `_${escapeMd(promptPreview)}_`,
    '',
    `Job: \`${escapeMd(context.jobId || '')}\``,
    'GPU worker is offline — wake it to process this job\\.',
  ].join('\n');

  const reply_markup = LIGHTNING_STUDIO_URL ? {
    inline_keyboard: [[
      { text: '🚀 Open Lightning Studio', url: LIGHTNING_STUDIO_URL },
    ]],
  } : undefined;

  try {
    const res = await fetch(`${TG_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
        reply_markup,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`Telegram send failed: ${res.status} ${body.slice(0, 200)}`);
      return { sent: false, status: res.status, body: body.slice(0, 200) };
    }
    logger.info(`Telegram wake alert sent for ${context.jobId}`);
    return { sent: true };
  } catch (err) {
    logger.warn(`Telegram error: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

export async function sendTelegramJobComplete(context = {}) {
  if (!isTelegramConfigured()) return { sent: false };

  const text = [
    '✅ *Video ready*',
    '',
    `_${escapeMd((context.prompt || '').slice(0, 160))}_`,
    '',
    `Provider: \`${escapeMd(context.provider || 'unknown')}\``,
  ].join('\n');

  const reply_markup = context.videoUrl ? {
    inline_keyboard: [[{ text: '▶️ Watch video', url: context.videoUrl }]],
  } : undefined;

  try {
    await fetch(`${TG_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text, parse_mode: 'MarkdownV2',
        disable_web_page_preview: true, reply_markup,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return { sent: true };
  } catch {
    return { sent: false };
  }
}
