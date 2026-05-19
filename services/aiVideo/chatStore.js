// Chat-job SQLite store for the AI Chat 5090 lane. Single-shot completions:
// FE sends messages + model + (optional) image, BE creates a row, queues it
// to chat_queue, worker pulls + calls Ollama + posts back the reply. FE polls
// /api/chat/status/:jobId until completed.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newChatJobId() {
  return `chat_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

const insertStmt = db.prepare(`INSERT INTO chat_jobs (
  jobId, status, model, messages, imageUrl, reply, elapsedMs,
  tokensIn, tokensOut, error, workerId, logs,
  createdAt, startedAt, completedAt,
  chatId, messageId, provider
) VALUES (
  @jobId, @status, @model, @messages, @imageUrl, @reply, @elapsedMs,
  @tokensIn, @tokensOut, @error, @workerId, @logs,
  @createdAt, @startedAt, @completedAt,
  @chatId, @messageId, @provider
)`);

const selectStmt = db.prepare('SELECT * FROM chat_jobs WHERE jobId = ?');
const deleteStmt = db.prepare('DELETE FROM chat_jobs WHERE jobId = ?');

const COLUMNS = new Set([
  'status', 'model', 'messages', 'imageUrl', 'reply', 'elapsedMs',
  'tokensIn', 'tokensOut', 'error', 'workerId', 'logs',
  'startedAt', 'completedAt',
  'chatId', 'messageId', 'provider',
]);

export function createChatJob({ model, messages, imageUrl = null,
                                chatId = null, messageId = null, provider = null }) {
  const row = {
    jobId: newChatJobId(),
    status: 'queued',
    model,
    messages: JSON.stringify(messages || []),
    imageUrl,
    reply: null,
    elapsedMs: null,
    tokensIn: null,
    tokensOut: null,
    error: null,
    workerId: null,
    logs: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    chatId,
    messageId,
    provider,
  };
  insertStmt.run(row);
  return row;
}

export function getChatJob(jobId) {
  return selectStmt.get(jobId) || null;
}

export function updateChatJob(jobId, patch) {
  const existing = selectStmt.get(jobId);
  if (!existing) return null;
  const cols = Object.keys(patch).filter(c => COLUMNS.has(c));
  if (cols.length === 0) return existing;
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE chat_jobs SET ${set} WHERE jobId = @jobId`)
    .run({ jobId, ...Object.fromEntries(cols.map(c => [c, patch[c]])) });
  return selectStmt.get(jobId);
}

export function deleteChatJob(jobId) {
  return deleteStmt.run(jobId).changes > 0;
}

// Cheap GC — older completed/failed rows after N days. Call from a cron
// if you want; not wired by default.
export function pruneOldChatJobs(maxAgeDays = 7) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000).toISOString();
  return db.prepare(
    `DELETE FROM chat_jobs WHERE status IN ('completed', 'failed') AND createdAt < ?`
  ).run(cutoff).changes;
}
