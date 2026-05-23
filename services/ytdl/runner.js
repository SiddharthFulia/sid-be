// yt-dl runner — backed by Cobalt (api.cobalt.tools).
//
// Why Cobalt instead of yt-dlp directly: YouTube blocks datacenter IPs
// (Oracle ARM, AWS, GCP) with "Sign in to confirm you're not a bot"
// regardless of cookies, because the cookie + IP shape doesn't match
// a residential browser session. Cobalt's infrastructure routes
// extraction through residential pools + rotating accounts that they
// maintain, so a single POST to their API returns a tunnel URL we can
// stream. No cookies, no proxies, no headless-Chrome on our side.
// MIT-licensed; we can self-host later (github.com/imputnet/cobalt)
// if the public instance flakes.
//
// Env overrides:
//   COBALT_API_URL  — defaults to https://api.cobalt.tools
//   COBALT_API_KEY  — set if your instance requires `Authorization`

import fs from 'fs';
import path from 'path';
import logger from '../../helpers/logger.js';
import { db } from '../aiVideo/db.js';
import { updateJob } from './store.js';

const COBALT_API_URL = (process.env.COBALT_API_URL || 'https://api.cobalt.tools').replace(/\/+$/, '');
const COBALT_API_KEY = process.env.COBALT_API_KEY || null;
const MAX_CONCURRENT = 3;

const ROOT = process.cwd();
export const DOWNLOADS_DIR = path.join(ROOT, 'data', 'yt-downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Same URL validator the old runner used so the controller doesn't have
// to change.
const YT_URL_RE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\/.+/i;
export const isValidYtUrl = (u) => typeof u === 'string' && YT_URL_RE.test(u.trim());

// Map our 6 quality knobs to Cobalt's enum strings.
const VIDEO_QUALITY_MAP = {
  '360':  '360',
  '720':  '720',
  '1080': '1080',
  'best': 'max',
};
const AUDIO_BITRATE_SET = new Set(['128', '192', '320']);

function buildCobaltBody({ url, format, quality }) {
  if (format === 'mp3') {
    return {
      url,
      downloadMode:  'audio',
      audioFormat:   'mp3',
      audioBitrate:  AUDIO_BITRATE_SET.has(quality) ? quality : '320',
      filenameStyle: 'pretty',
    };
  }
  return {
    url,
    downloadMode:        'auto',
    videoQuality:        VIDEO_QUALITY_MAP[quality] || '720',
    filenameStyle:       'pretty',
    youtubeVideoCodec:   'h264',         // h264 muxes into mp4 cleanly; av1/vp9 prefer mkv
  };
}

async function callCobalt(body) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
  if (COBALT_API_KEY) headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;

  const res = await fetch(COBALT_API_URL + '/', {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cobalt API ${res.status}: ${text.slice(0, 240) || res.statusText}`);
  }
  const data = await res.json();
  if (data.status === 'error') {
    const code = data.error?.code || 'unknown';
    throw new Error(`Cobalt refused: ${code}`);
  }
  if (data.status === 'picker') {
    throw new Error('That URL returned a multi-track picker (likely a playlist) — submit a single video');
  }
  // Both 'tunnel' and 'redirect' give us a downloadable URL.
  if (!data.url) throw new Error('Cobalt returned no download URL');
  return { downloadUrl: data.url, filename: data.filename || null };
}

// Stream the Cobalt tunnel response straight into the final job file
// path, updating the progress column at most once per percentage point.
async function streamToDisk(downloadUrl, finalPath, jobId) {
  const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) throw new Error(`Tunnel HTTP ${res.status} ${res.statusText}`);
  const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);

  const tmpPath = finalPath + '.tmp';
  const file = fs.createWriteStream(tmpPath);
  let received = 0;
  let lastPct = 0;

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      file.write(Buffer.from(value));
      received += value.length;
      if (totalBytes) {
        const pct = Math.floor((received / totalBytes) * 100);
        if (pct - lastPct >= 1) {
          lastPct = pct;
          updateJob(jobId, { progress: pct });
        }
      }
    }
  } finally {
    await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()));
  }
  fs.renameSync(tmpPath, finalPath);
  return received;
}

// Sanitise the filename Cobalt returns so it's safe on every FS we care
// about. We DON'T restrict to ASCII — Cobalt's 'pretty' style produces
// readable Unicode titles which we want to keep for the FE display.
function safeFilename(name) {
  return String(name || '')
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// Public entry point — controller calls scheduleNext() after creating a
// row, which calls this for each free slot.
export async function startDownload(job) {
  updateJob(job.id, { status: 'processing', progress: 0 });
  try {
    const body = buildCobaltBody({ url: job.url, format: job.format, quality: job.quality });
    logger.info(`cobalt start jobId=${job.id} fmt=${job.format} q=${job.quality} url=${job.url}`);
    const { downloadUrl, filename } = await callCobalt(body);

    const fallbackName = `yt-${job.id}.${job.format}`;
    const cleanFilename = safeFilename(filename) || fallbackName;
    // Prefix with jobId so concurrent jobs can't collide on the same name.
    const finalName = `${job.id}-${cleanFilename}`;
    const finalPath = path.join(DOWNLOADS_DIR, finalName);

    const bytes = await streamToDisk(downloadUrl, finalPath, job.id);

    updateJob(job.id, {
      status:      'completed',
      progress:    100,
      title:       cleanFilename.replace(/\.[^.]+$/, ''),
      filePath:    finalPath,
      fileName:    finalName,
      fileSize:    bytes,
      completedAt: new Date().toISOString(),
    });
    logger.info(`cobalt done jobId=${job.id} size=${bytes} file=${finalName}`);
  } catch (err) {
    updateJob(job.id, {
      status:      'failed',
      error:       err?.message || String(err),
      completedAt: new Date().toISOString(),
    });
    logger.warn(`cobalt failed jobId=${job.id}: ${err?.message || err}`);
  } finally {
    // Whether we succeeded or failed, give the next queued job a chance
    // to start now that we've freed a slot.
    setImmediate(scheduleNext);
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────
// Picks the oldest queued job and spawns it, as long as the count of
// 'processing' rows is below MAX_CONCURRENT.
export function scheduleNext() {
  const active = db
    .prepare(`SELECT COUNT(*) AS n FROM yt_jobs WHERE status = 'processing'`)
    .get().n;
  if (active >= MAX_CONCURRENT) return;
  const next = db
    .prepare(`SELECT * FROM yt_jobs WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1`)
    .get();
  if (!next) return;
  startDownload(next);
}

// ─── Orphan recovery ────────────────────────────────────────────────
// On boot, any row still flagged 'processing' is stale (the BE was
// restarted mid-download). Mark them failed so the FE shows truth.
export function recoverOrphans() {
  try {
    const res = db.prepare(
      `UPDATE yt_jobs
       SET status='failed',
           error='BE restarted while this job was running — please re-submit',
           completedAt=?,
           pid=NULL
       WHERE status='processing'`
    ).run(new Date().toISOString());
    if (res.changes > 0) logger.warn(`yt-dl recovered ${res.changes} orphan(s) on boot`);
  } catch (err) {
    logger.warn(`yt-dl orphan recovery failed: ${err.message}`);
  }
}

setImmediate(() => {
  recoverOrphans();
  scheduleNext();
});
