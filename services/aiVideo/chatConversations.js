// SQLite store for chat conversations + messages. Keeps the controller
// thin; mirrors the pattern used by audioStore / lipsyncStore.

import { randomUUID } from 'crypto';
import { db } from './db.js';

export function newChatId() { return `cv_${Date.now()}_${randomUUID().slice(0, 8)}`; }
export function newMessageId() { return `mg_${Date.now()}_${randomUUID().slice(0, 8)}`; }

// ─── Conversations ─────────────────────────────────────────────

const convInsertStmt = db.prepare(`INSERT INTO chat_conversations
  (chatId, title, model, provider, pinned, archived, vault, createdAt, updatedAt)
  VALUES (@chatId, @title, @model, @provider, @pinned, @archived, @vault, @createdAt, @updatedAt)`);

const convSelectStmt = db.prepare('SELECT * FROM chat_conversations WHERE chatId = ?');
const convDeleteStmt = db.prepare('DELETE FROM chat_conversations WHERE chatId = ?');

const CONV_COLS = new Set(['title', 'model', 'provider', 'pinned', 'archived', 'vault', 'updatedAt']);

export function createConversation({ title = 'New chat', model = null, provider = null } = {}) {
  const now = new Date().toISOString();
  const row = {
    chatId: newChatId(),
    title: String(title || 'New chat').slice(0, 200),
    model,
    provider,
    pinned: 0,
    archived: 0,
    vault: 0,
    createdAt: now,
    updatedAt: now,
  };
  convInsertStmt.run(row);
  return row;
}

export function getConversation(chatId) {
  return convSelectStmt.get(chatId) || null;
}

export function updateConversation(chatId, patch) {
  const existing = convSelectStmt.get(chatId);
  if (!existing) return null;
  // Always bump updatedAt
  patch = { ...patch, updatedAt: new Date().toISOString() };
  const cols = Object.keys(patch).filter(c => CONV_COLS.has(c));
  if (cols.length === 0) return existing;
  const set = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE chat_conversations SET ${set} WHERE chatId = @chatId`)
    .run({ chatId, ...Object.fromEntries(cols.map(c => [c, patch[c]])) });
  return convSelectStmt.get(chatId);
}

export function deleteConversation(chatId) {
  // CASCADE on the FK handles chat_messages cleanup
  return convDeleteStmt.run(chatId).changes > 0;
}

export function deleteConversations(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`DELETE FROM chat_conversations WHERE chatId IN (${placeholders})`).run(...ids).changes;
}

export function listConversations({ archived = 0, page = 1, limit = 50 } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  const items = db.prepare(`
    SELECT chatId, title, model, provider, pinned, archived, vault, createdAt, updatedAt
      FROM chat_conversations
     WHERE archived = @archived
     ORDER BY pinned DESC, updatedAt DESC
     LIMIT @limit OFFSET @offset
  `).all({ archived, limit, offset });
  const total = db.prepare('SELECT COUNT(*) AS n FROM chat_conversations WHERE archived = ?').get(archived).n;
  // Attach a quick "lastMessage" snippet for the sidebar (cheap subquery)
  const previewStmt = db.prepare(
    `SELECT role, content FROM chat_messages WHERE chatId = ? ORDER BY createdAt DESC LIMIT 1`
  );
  const items2 = items.map(it => {
    const last = previewStmt.get(it.chatId);
    return {
      ...it,
      lastRole: last?.role || null,
      lastSnippet: last?.content ? String(last.content).slice(0, 120) : '',
    };
  });
  return { items: items2, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

// ─── Messages ──────────────────────────────────────────────────

const msgInsertStmt = db.prepare(`INSERT INTO chat_messages
  (messageId, chatId, role, content, imageUrl, docName, docText, model, provider,
   tokensIn, tokensOut, elapsedMs, jobId, createdAt)
  VALUES (@messageId, @chatId, @role, @content, @imageUrl, @docName, @docText, @model, @provider,
          @tokensIn, @tokensOut, @elapsedMs, @jobId, @createdAt)`);

const msgListStmt = db.prepare(
  `SELECT * FROM chat_messages WHERE chatId = ? ORDER BY createdAt ASC`
);

export function appendMessage({
  chatId, role, content, imageUrl = null, docName = null, docText = null,
  model = null, provider = null, tokensIn = null, tokensOut = null,
  elapsedMs = null, jobId = null,
} = {}) {
  if (!chatId) throw new Error('chatId required');
  if (!role || !content) throw new Error('role + content required');
  const row = {
    messageId: newMessageId(),
    chatId, role, content,
    imageUrl, docName, docText, model, provider,
    tokensIn, tokensOut, elapsedMs, jobId,
    createdAt: new Date().toISOString(),
  };
  msgInsertStmt.run(row);
  // Bump the conversation's updatedAt so the sidebar resorts it to top
  db.prepare('UPDATE chat_conversations SET updatedAt = ? WHERE chatId = ?')
    .run(row.createdAt, chatId);
  return row;
}

export function listMessages(chatId) {
  return msgListStmt.all(chatId);
}

// Used by the worker callback flow: find the conversation a chat_job
// belongs to so we can append the assistant reply.
const jobToChatStmt = db.prepare(
  `SELECT chatId, messageId, model, provider FROM chat_jobs WHERE jobId = ?`
);
export function getJobChat(jobId) {
  return jobToChatStmt.get(jobId) || null;
}
