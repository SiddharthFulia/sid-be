// yt-dlp subprocess runner. Spawns the binary with the appropriate
// format / quality args, parses progress lines off stdout, and persists
// the final filename + size to the yt_jobs row when the child exits.
//
// Assumes `yt-dlp` is on PATH. Install on Ubuntu/Oracle ARM:
//   sudo apt install yt-dlp ffmpeg    (or `pip install -U yt-dlp` for newer)
// ffmpeg is required for MP3 extraction + the bestvideo+bestaudio mux.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../../helpers/logger.js';
import { db } from '../aiVideo/db.js';
import { updateJob, getJob } from './store.js';

// At most 3 yt-dlp subprocesses concurrently. Anything beyond this stays
// in 'queued' status and gets picked up by scheduleNext() as capacity
// frees. Higher values just thrash CPU + network without buying speed.
const MAX_CONCURRENT = 3;

const ROOT = process.cwd();
export const DOWNLOADS_DIR = path.join(ROOT, 'data', 'yt-downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Sanity-check the URL pattern before we spawn anything — covers
// youtube.com/watch, youtu.be/, youtube.com/shorts/, youtube.com/playlist.
const YT_URL_RE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\/.+/i;
export const isValidYtUrl = (u) => typeof u === 'string' && YT_URL_RE.test(u.trim());

const AUDIO_QUALITY = {
  '128': '5',     // yt-dlp scale 0(best)..10(worst); 5 ≈ 128k
  '192': '3',
  '320': '0',
};

// Real browser UA — yt-dlp's default UA gets caught by YouTube's
// anti-bot heuristics from cloud-IP ranges. Pretending to be Safari
// (which corresponds to one of the player_client values below) lines
// up better with the headers YouTube expects.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

// Player-client chain. As of 2025-Q2, datacenter IPs hitting the default
// `web` player hit the "Sign in to confirm you're not a bot" wall almost
// immediately. The TV-embedded + iOS clients use different signed-URL
// shapes that YouTube hasn't locked down to the same extent. Listing
// multiple makes yt-dlp fall through in order until one works.
const PLAYER_CLIENTS = 'tv_embedded,ios,web_safari';

function buildArgs({ url, format, quality, jobId }) {
  // Output template — prefix with job id so concurrent jobs don't collide.
  // %(title)s gets sanitised by yt-dlp.
  const out = path.join(DOWNLOADS_DIR, `${jobId}-%(title).80s.%(ext)s`);
  const base = [
    '--no-playlist',
    '--newline',                    // emit \n on progress (not \r) — easier to line-parse
    '--no-colors',
    '--no-warnings',
    '--restrict-filenames',         // ASCII-only filenames so the FE Content-Disposition is safe
    '--user-agent', BROWSER_UA,
    '--extractor-args', `youtube:player_client=${PLAYER_CLIENTS}`,
    '--sleep-requests', '1',        // be polite — 1s between API requests so we don't rate-limit ourselves
    '-o', out,
  ];
  // Optional: path to a cookies.txt exported from a logged-in browser.
  // Most reliable bypass for "Sign in to confirm you're not a bot" when
  // the player_client chain isn't enough. Defaults to
  // <cwd>/data/yt-cookies.txt — drop a file there and yt-dlp uses it
  // automatically.
  const defaultCookies = path.join(ROOT, 'data', 'yt-cookies.txt');
  const cookiesPath = process.env.YT_COOKIES_PATH || (fs.existsSync(defaultCookies) ? defaultCookies : null);
  if (cookiesPath) base.push('--cookies', cookiesPath);
  if (format === 'mp3') {
    const q = AUDIO_QUALITY[quality] ?? '0';
    base.push('-x', '--audio-format', 'mp3', '--audio-quality', q);
  } else {
    // mp4. 'best' = no height cap.
    const cap = quality === 'best' ? '' : `[height<=${parseInt(quality, 10) || 720}]`;
    base.push(
      '-f', `bestvideo${cap}+bestaudio/best${cap}`,
      '--merge-output-format', 'mp4',
    );
  }
  base.push(url);
  return base;
}

// Look for the produced file on disk. yt-dlp's output template gives us
// `{jobId}-<title>.<ext>` — we glob the downloads dir for the prefix.
function findProducedFile(jobId, format) {
  const prefix = `${jobId}-`;
  const ext = format === 'mp3' ? '.mp3' : '.mp4';
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith(ext));
    if (!files.length) return null;
    // Prefer the most-recently-modified one if somehow multiple matched.
    let best = files[0];
    let bestMtime = 0;
    for (const f of files) {
      const m = fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs;
      if (m > bestMtime) { best = f; bestMtime = m; }
    }
    return path.join(DOWNLOADS_DIR, best);
  } catch (err) {
    logger.warn(`yt-dlp findProducedFile error: ${err.message}`);
    return null;
  }
}

// Parse a stdout line for the progress percentage. yt-dlp emits:
//   [download]   5.2% of ~123.4MiB at 1.2MiB/s ETA 01:23
//   [download] 100% of 123.4MiB in 00:42
const PROGRESS_RE   = /\[download\]\s+(\d+(?:\.\d+)?)%/;
const TITLE_RE      = /\[info\]\s+([^\:]+):\s+Downloading/;          // weak signal but it's free
const DURATION_RE   = /\bDuration:\s*(\d+):(\d+):(\d+)/i;             // ffmpeg-passthrough lines

export function startDownload(job) {
  const args = buildArgs({
    url:    job.url,
    format: job.format,
    quality: job.quality,
    jobId:  job.id,
  });
  logger.info(`yt-dlp start jobId=${job.id} fmt=${job.format} q=${job.quality} url=${job.url}`);

  const proc = spawn('yt-dlp', args, { windowsHide: true });
  updateJob(job.id, { status: 'processing', progress: 0, pid: proc.pid });

  let lastProgress = 0;
  let stderrBuf = '';
  let detectedTitle = null;
  let detectedDuration = null;

  // Throttle DB writes — only update if the percent moved by at least 1.
  const onLine = (line) => {
    const pm = PROGRESS_RE.exec(line);
    if (pm) {
      const pct = Math.max(0, Math.min(100, Math.floor(parseFloat(pm[1]))));
      if (pct - lastProgress >= 1) {
        lastProgress = pct;
        updateJob(job.id, { progress: pct });
      }
      return;
    }
    const tm = TITLE_RE.exec(line);
    if (tm && !detectedTitle) {
      detectedTitle = tm[1].trim();
    }
    const dm = DURATION_RE.exec(line);
    if (dm && !detectedDuration) {
      detectedDuration = (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]);
    }
  };

  proc.stdout.on('data', (chunk) => {
    const lines = String(chunk).split(/\r?\n/);
    for (const l of lines) if (l) onLine(l);
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuf += String(chunk);
    // yt-dlp uses stderr for some informational lines too; mine progress
    // there as a fallback.
    const lines = String(chunk).split(/\r?\n/);
    for (const l of lines) if (l) onLine(l);
  });

  proc.on('error', (err) => {
    logger.error(`yt-dlp spawn failed jobId=${job.id}: ${err.message}`);
    updateJob(job.id, {
      status: 'failed',
      error: `yt-dlp not available on the BE (install yt-dlp + ffmpeg). ${err.message}`,
      completedAt: new Date().toISOString(),
    });
  });

  const finalise = () => {
    // Always try to pull the next queued job after this one terminates,
    // regardless of success/failure. Run on next tick so the row we just
    // updated is committed.
    setImmediate(scheduleNext);
  };

  proc.on('close', (code) => {
    if (code === 0) {
      const filePath = findProducedFile(job.id, job.format);
      if (!filePath) {
        updateJob(job.id, {
          status: 'failed',
          error: 'yt-dlp exited 0 but no output file matched the job prefix',
          completedAt: new Date().toISOString(),
        });
        return;
      }
      let fileSize = 0;
      try { fileSize = fs.statSync(filePath).size; } catch {}
      const fileName = path.basename(filePath);
      updateJob(job.id, {
        status:      'completed',
        progress:    100,
        title:       detectedTitle || fileName,
        duration:    detectedDuration || null,
        filePath, fileName, fileSize,
        completedAt: new Date().toISOString(),
      });
      logger.info(`yt-dlp done jobId=${job.id} size=${fileSize} file=${fileName}`);
    } else {
      const errText = (stderrBuf || '').slice(-1200).trim() || `yt-dlp exited with code ${code}`;
      updateJob(job.id, {
        status:      'failed',
        error:       errText,
        completedAt: new Date().toISOString(),
      });
      logger.warn(`yt-dlp failed jobId=${job.id} code=${code}: ${errText.slice(0, 240)}`);
    }
    finalise();
  });

  return proc;
}

// ─── Scheduler ──────────────────────────────────────────────────────
// Picks the oldest queued job and spawns it, as long as the count of
// 'processing' rows is below MAX_CONCURRENT. Called whenever a job is
// created or finishes; also runs once at boot to drain anything left
// 'queued' from before a BE restart.
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
// On BE boot, any row still flagged 'processing' is stale — the yt-dlp
// child is gone (BE was restarted). Mark them failed so the FE shows
// the truth instead of an infinite spinner. The user can re-submit.
export function recoverOrphans() {
  try {
    const stmt = db.prepare(
      `UPDATE yt_jobs
       SET status='failed',
           error='BE restarted while this job was running — please re-submit',
           completedAt=?,
           pid=NULL
       WHERE status='processing'`
    );
    const now = new Date().toISOString();
    const res = stmt.run(now);
    if (res.changes > 0) logger.warn(`yt-dlp recovered ${res.changes} orphan(s) on boot`);
  } catch (err) {
    logger.warn(`yt-dlp orphan recovery failed: ${err.message}`);
  }
}

// Boot-time pass: clear stale 'processing' rows, then drain the queue
// up to MAX_CONCURRENT in case the BE restarted with queued work
// pending. Wrapped in setImmediate so module-load order is fine.
setImmediate(() => {
  recoverOrphans();
  scheduleNext();
});
