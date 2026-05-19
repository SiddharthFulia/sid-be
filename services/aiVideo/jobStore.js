// Worker heartbeat tracker — supports multiple workers keyed by role.
// Roles: 'worker' (Lightning AI ComfyUI), 'local' (user's own GPU PC).
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const WORKER_FILE = path.join(ROOT, 'data', 'gpu-worker-status.json');

async function ensure() {
  await fs.mkdir(path.dirname(WORKER_FILE), { recursive: true });
  try { await fs.access(WORKER_FILE); }
  catch { await fs.writeFile(WORKER_FILE, '{}', 'utf8'); }
}

async function readAll() {
  await ensure();
  try {
    const raw = await fs.readFile(WORKER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function writeAll(obj) {
  await ensure();
  await fs.writeFile(WORKER_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

export async function recordWorkerHeartbeat(workerId, role = 'worker', extras = {}) {
  const all = await readAll();
  const entry = {
    workerId, role,
    lastSeenAt: new Date().toISOString(),
    // Optional: { ollamaModels: [{ name, size }, …] } reported by the
    // 5090 worker on each register so the FE can list installed models
    // without a direct round-trip to the home network.
    ...(extras.ollamaModels ? { ollamaModels: extras.ollamaModels } : {}),
  };
  // Migration: if file is in legacy flat shape, move existing entry to its role bucket.
  if (all.workerId && !all.workers) {
    all.workers = { [all.role || 'worker']: { workerId: all.workerId, role: all.role || 'worker', lastSeenAt: all.lastSeenAt } };
    delete all.workerId; delete all.role; delete all.lastSeenAt;
  }
  all.workers = all.workers || {};
  // Preserve previously-reported ollamaModels if the new heartbeat doesn't carry one
  const prev = all.workers[role] || {};
  if (!extras.ollamaModels && prev.ollamaModels) entry.ollamaModels = prev.ollamaModels;
  all.workers[role] = entry;
  await writeAll(all);
  return entry;
}

export async function getWorkerStatus(role = 'worker') {
  const all = await readAll();
  // Legacy flat-shape fallback
  if (all.workerId && !all.workers) return all;
  return all.workers?.[role] || {};
}

export async function getAllWorkerStatuses() {
  const all = await readAll();
  if (all.workerId && !all.workers) return { [all.role || 'worker']: all };
  return all.workers || {};
}

export function isWorkerOnline(status, maxAgeSec = 30) {
  if (!status?.lastSeenAt) return false;
  const age = (Date.now() - new Date(status.lastSeenAt)) / 1000;
  return age < maxAgeSec;
}
