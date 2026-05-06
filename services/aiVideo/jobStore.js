// Worker heartbeat tracker — used by /api/gpu-worker/register and getNextJob.
// Job records themselves now live in the unified storage.js metadata file.
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const WORKER_FILE = path.join(ROOT, 'data', 'gpu-worker-status.json');

async function ensure() {
  await fs.mkdir(path.dirname(WORKER_FILE), { recursive: true });
  try { await fs.access(WORKER_FILE); }
  catch { await fs.writeFile(WORKER_FILE, '{}', 'utf8'); }
}

export async function recordWorkerHeartbeat(workerId) {
  await ensure();
  const data = { workerId, lastSeenAt: new Date().toISOString() };
  await fs.writeFile(WORKER_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export async function getWorkerStatus() {
  await ensure();
  try { return JSON.parse(await fs.readFile(WORKER_FILE, 'utf8')); }
  catch { return {}; }
}

export function isWorkerOnline(status, maxAgeSec = 30) {
  if (!status?.lastSeenAt) return false;
  const age = (Date.now() - new Date(status.lastSeenAt)) / 1000;
  return age < maxAgeSec;
}
