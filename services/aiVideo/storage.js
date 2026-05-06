// Lightweight in-flight job tracker — ONLY for queued/processing/failed worker jobs.
// Completed videos live on Cloudinary (see cloudinaryStore.js) and are NOT recorded here.
//
// Why two stores:
//   - Cloudinary: persistent, single source of truth for completed videos
//   - JSON file:  ephemeral, per-env, holds jobs that are mid-flight (no Cloudinary URL yet)

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const ROOT = process.cwd();
const META_DIR = path.join(ROOT, 'data');
const JOBS_FILE = path.join(META_DIR, 'inflight-jobs.json');

async function ensure() {
  await fs.mkdir(META_DIR, { recursive: true });
  try { await fs.access(JOBS_FILE); }
  catch { await fs.writeFile(JOBS_FILE, '[]', 'utf8'); }
}

export function newVideoId() {
  return `vid_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

async function readAll() {
  await ensure();
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeAll(items) {
  await ensure();
  await fs.writeFile(JOBS_FILE, JSON.stringify(items.slice(0, 200), null, 2), 'utf8');
}

export async function createInflightJob(jobData) {
  const items = await readAll();
  const job = {
    videoId: newVideoId(),
    status: 'queued',
    attemptCount: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    videoUrl: null,
    caption: null,
    error: null,
    workerId: null,
    ...jobData,
  };
  items.unshift(job);
  await writeAll(items);
  return job;
}

export async function getInflightJob(videoId) {
  const items = await readAll();
  return items.find(j => j.videoId === videoId) || null;
}

export async function updateInflightJob(videoId, patch) {
  const items = await readAll();
  const idx = items.findIndex(j => j.videoId === videoId);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  await writeAll(items);
  return items[idx];
}

export async function removeInflightJob(videoId) {
  const items = await readAll();
  const filtered = items.filter(j => j.videoId !== videoId);
  await writeAll(filtered);
  return items.length !== filtered.length;
}

export async function getNextQueuedWorkerJob() {
  const items = await readAll();
  return items
    .filter(j => j.provider === 'worker' && j.status === 'queued')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
}

export async function listInflightJobs() {
  return await readAll();
}
