import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const ROOT = process.cwd();
const JOBS_FILE = path.join(ROOT, 'data', 'ai-video-jobs.json');
const WORKER_FILE = path.join(ROOT, 'data', 'gpu-worker-status.json');

const MAX_JOBS = 200;

async function ensureFile(file, fallback) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, JSON.stringify(fallback), 'utf8');
  }
}

export async function readJobs() {
  await ensureFile(JOBS_FILE, []);
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJobs(jobs) {
  await ensureFile(JOBS_FILE, []);
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs.slice(0, MAX_JOBS), null, 2), 'utf8');
}

export function newJobId() {
  return `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export async function createJob(jobData) {
  const jobs = await readJobs();
  const job = {
    jobId: newJobId(),
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
  jobs.unshift(job);
  await writeJobs(jobs);
  return job;
}

export async function getJob(jobId) {
  const jobs = await readJobs();
  return jobs.find(j => j.jobId === jobId) || null;
}

export async function updateJob(jobId, updates) {
  const jobs = await readJobs();
  const idx = jobs.findIndex(j => j.jobId === jobId);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...updates };
  await writeJobs(jobs);
  return jobs[idx];
}

export async function getNextQueuedForProvider(providers) {
  const jobs = await readJobs();
  const eligible = jobs
    .filter(j => j.status === 'queued' && providers.includes(j.provider))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return eligible[0] || null;
}

export async function getQueuedForBE() {
  const jobs = await readJobs();
  return jobs
    .filter(j => j.status === 'queued' && ['zsky', 'auto'].includes(j.provider))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export async function getRecentJobs(limit = 20) {
  const jobs = await readJobs();
  return jobs.slice(0, limit);
}

export async function getLatestCompletedJob() {
  const jobs = await readJobs();
  return jobs.find(j => j.status === 'completed') || null;
}

export async function recordWorkerHeartbeat(workerId) {
  await ensureFile(WORKER_FILE, {});
  const data = { workerId, lastSeenAt: new Date().toISOString() };
  await fs.writeFile(WORKER_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export async function getWorkerStatus() {
  await ensureFile(WORKER_FILE, {});
  try {
    const raw = await fs.readFile(WORKER_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function isWorkerOnline(status, maxAgeSec = 30) {
  if (!status?.lastSeenAt) return false;
  const age = (Date.now() - new Date(status.lastSeenAt)) / 1000;
  return age < maxAgeSec;
}
