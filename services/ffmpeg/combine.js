// ffmpeg combine — concatenates N video URLs/paths into one mp4.
//
// Two strategies:
//   1. concat demuxer with -c copy  (fast — no re-encode)
//      Requires every input to share the same codec / resolution / fps.
//   2. concat filter_complex        (slower — full re-encode)
//      Works regardless of input differences. Used as fallback if (1) fails.
//
// All AI-generated videos coming out of /ai-video typically share the
// same encoder + resolution, so (1) succeeds most of the time. yt-dl
// outputs occasionally differ; (2) catches those.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import logger from '../../helpers/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = process.cwd();
export const COMBINED_DIR = path.join(ROOT, 'data', 'combined-videos');
fs.mkdirSync(COMBINED_DIR, { recursive: true });

// Download a remote URL to a temp file. Returns the local path.
// Used to pull Cloudinary-hosted videos onto disk so ffmpeg can read
// them (ffmpeg can stream from HTTP too, but that's flaky on Oracle's
// shared bandwidth and re-buffers during the concat). Disk-local first.
function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow one redirect (Cloudinary occasionally does this).
        downloadTo(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', reject);
    file.on('error', (err) => { fs.unlink(dest, () => reject(err)); });
  });
}

// Run ffmpeg + collect stderr (where it writes progress lines). Resolves
// on exit 0 with the stderr text, rejects with the same text on non-zero.
function runFfmpeg(args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      // ffmpeg progress lines look like:  frame=  120 fps=24 q=28.0 size=1024kB time=00:00:05.00 ...
      // Surface the time component for any caller that wants to thread it
      // into a job-progress percent.
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (m && onProgress) {
        const seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress(seconds);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.slice(-1200) || `ffmpeg exit ${code}`));
    });
  });
}

// Probe a file's duration in seconds via ffprobe. Used to size the
// progress bar — we sum source durations to know the total output
// length and report (currentTime / totalSeconds) % during the concat.
async function probeDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (c) => { out += String(c); });
    proc.on('close', () => {
      const d = parseFloat(out.trim());
      resolve(Number.isFinite(d) ? d : 0);
    });
    proc.on('error', () => resolve(0));
  });
}

// Public entry point. `sources` is an ordered array of either
// remote URLs or local paths. Returns { outputPath, sizeBytes,
// strategy: 'copy' | 'reencode' }.
//
// onLog(line)       — emits high-level progress messages
// onProgress(pct)   — emits 0..100 as the concat advances
export async function combineVideos(jobId, sources, { onLog, onProgress } = {}) {
  if (!Array.isArray(sources) || sources.length < 2) {
    throw new Error('combineVideos needs at least 2 sources');
  }
  const tmpDir = path.join(os.tmpdir(), `sid-combine-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // ── Step 1: download remote sources to disk ────────────────────────
  onLog?.('Resolving sources…');
  const localPaths = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const isUrl = /^https?:\/\//i.test(src);
    if (isUrl) {
      const dest = path.join(tmpDir, `src-${i}.mp4`);
      onLog?.(`Downloading [${i + 1}/${sources.length}] ${src.slice(0, 80)}…`);
      await downloadTo(src, dest);
      localPaths.push(dest);
    } else {
      if (!fs.existsSync(src)) throw new Error(`source not found: ${src}`);
      localPaths.push(src);
    }
  }

  // ── Step 2: measure total duration for progress ────────────────────
  onLog?.('Probing durations…');
  const durations = [];
  for (const p of localPaths) durations.push(await probeDuration(p));
  const totalSeconds = durations.reduce((a, b) => a + b, 0);
  onLog?.(`Total output: ${totalSeconds.toFixed(1)}s across ${localPaths.length} clips`);

  // ── Step 3: write the concat-demuxer playlist ──────────────────────
  const listPath = path.join(tmpDir, 'list.txt');
  fs.writeFileSync(listPath,
    localPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`).join(''),
    'utf8',
  );

  const outputPath = path.join(COMBINED_DIR, `${jobId}.mp4`);

  // ── Step 4a: try fast path (no re-encode) ──────────────────────────
  try {
    onLog?.('Trying fast concat (no re-encode)…');
    await runFfmpeg([
      '-y',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath,
    ], {
      onProgress: (seconds) => {
        if (totalSeconds > 0) onProgress?.(Math.min(100, Math.floor((seconds / totalSeconds) * 100)));
      },
    });
    const size = fs.statSync(outputPath).size;
    onLog?.(`Done · ${(size / 1024 / 1024).toFixed(1)} MB · fast path`);
    // Best-effort cleanup of the temp dir.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { outputPath, sizeBytes: size, strategy: 'copy' };
  } catch (err) {
    onLog?.(`Fast path failed (${err.message.split('\n')[0].slice(0, 120)}) — falling back to re-encode`);
  }

  // ── Step 4b: fallback — full re-encode with concat filter ──────────
  try {
    // Build the filter_complex: [0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1[v][a]
    const inputs = [];
    const filterParts = [];
    for (let i = 0; i < localPaths.length; i++) {
      inputs.push('-i', localPaths[i]);
      filterParts.push(`[${i}:v][${i}:a]`);
    }
    const filter = `${filterParts.join('')}concat=n=${localPaths.length}:v=1:a=1[v][a]`;
    await runFfmpeg([
      '-y',
      ...inputs,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath,
    ], {
      onProgress: (seconds) => {
        if (totalSeconds > 0) onProgress?.(Math.min(100, Math.floor((seconds / totalSeconds) * 100)));
      },
    });
    const size = fs.statSync(outputPath).size;
    onLog?.(`Done · ${(size / 1024 / 1024).toFixed(1)} MB · re-encode path`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { outputPath, sizeBytes: size, strategy: 'reencode' };
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}
