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

const CONV_COLS = new Set([
  'title', 'model', 'provider', 'pinned', 'archived', 'vault', 'updatedAt',
  'temperature', 'maxTokens',
  'imageGenEnabled', 'imageGenModel',
]);

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

// Conversation delete: 3 tables touched in one transaction.
//   - chat_messages    → CASCADE FK handles it automatically
//   - chat_jobs        → plain TEXT chatId, no FK; nuke manually
//   - chat_conversations → the row itself
// Cloudinary-stored images / docs referenced by deleted messages are
// NOT cleaned up — they may be referenced elsewhere and orphan files
// cost almost nothing. A future cron can prune unreferenced URLs.
export function deleteConversation(chatId) {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM chat_jobs WHERE chatId = ?').run(id);
    // CASCADE handles chat_messages
    return convDeleteStmt.run(id).changes;
  });
  return tx(chatId) > 0;
}

export function deleteConversations(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const tx = db.transaction((arr) => {
    db.prepare(`DELETE FROM chat_jobs WHERE chatId IN (${placeholders})`).run(...arr);
    return db.prepare(`DELETE FROM chat_conversations WHERE chatId IN (${placeholders})`)
      .run(...arr).changes;
  });
  return tx(ids);
}

// Listing the sidebar — pulls every conversation plus a few cheap
// aggregates so the FE can sort by "biggest" / "longest read" without a
// second round-trip. `messageCount` and `totalChars` exclude compacted
// messages (those are zombies kept for audit, not part of live context).
export function listConversations({ archived = 0, page = 1, limit = 50 } = {}) {
  const offset = (Math.max(page, 1) - 1) * limit;
  const items = db.prepare(`
    SELECT chatId, title, model, provider, pinned, archived, vault,
           temperature, maxTokens, imageGenEnabled, imageGenModel,
           createdAt, updatedAt
      FROM chat_conversations
     WHERE archived = @archived
     ORDER BY pinned DESC, updatedAt DESC
     LIMIT @limit OFFSET @offset
  `).all({ archived, limit, offset });
  const total = db.prepare('SELECT COUNT(*) AS n FROM chat_conversations WHERE archived = ?').get(archived).n;
  // Attach a quick "lastMessage" snippet for the sidebar (cheap subquery)
  const previewStmt = db.prepare(
    `SELECT role, content FROM chat_messages
      WHERE chatId = ? AND compacted = 0
      ORDER BY createdAt DESC LIMIT 1`
  );
  const aggStmt = db.prepare(
    `SELECT COUNT(*) AS messageCount,
            COALESCE(SUM(LENGTH(content)), 0) AS totalChars,
            COALESCE(SUM(CASE WHEN compacted = 1 THEN 1 ELSE 0 END), 0) AS compactedCount
       FROM chat_messages WHERE chatId = ? AND compacted = 0`
  );
  const items2 = items.map(it => {
    const last = previewStmt.get(it.chatId);
    const agg = aggStmt.get(it.chatId);
    return {
      ...it,
      lastRole: last?.role || null,
      lastSnippet: last?.content ? String(last.content).slice(0, 120) : '',
      messageCount: agg?.messageCount || 0,
      totalChars:   agg?.totalChars   || 0,
      compactedCount: agg?.compactedCount || 0,
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

// Compacted messages are hidden from the FE + from the prompt history;
// the synthetic system-summary row inserted by compactConversation()
// takes their place. include=all gives admin access to every row.
const msgListStmt = db.prepare(
  `SELECT * FROM chat_messages WHERE chatId = ? AND compacted = 0 ORDER BY createdAt ASC`
);
const msgListAllStmt = db.prepare(
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

export function listMessages(chatId, { includeCompacted = false } = {}) {
  return (includeCompacted ? msgListAllStmt : msgListStmt).all(chatId);
}

// Mark every non-compacted message older than `keepLastN` as compacted,
// then insert a single role='system' summary message in their place.
// Atomic — either all marked + summary inserted, or nothing changes.
// Returns { compacted: N, summaryMessage }. Throws if too few messages.
export function compactConversation({ chatId, summary, keepLastN = 4 }) {
  if (!chatId) throw new Error('chatId required');
  if (!summary || typeof summary !== 'string') throw new Error('summary required');

  const live = msgListStmt.all(chatId);
  if (live.length <= keepLastN + 1) {
    throw new Error(`Need more than ${keepLastN + 1} messages to compact (have ${live.length})`);
  }
  const toCompact = live.slice(0, live.length - keepLastN);
  const ids = toCompact.map(m => m.messageId);
  const summaryRow = {
    messageId: newMessageId(),
    chatId,
    role: 'system',
    content: `[Earlier conversation compacted — ${ids.length} messages summarized to save context]\n\n${summary}`,
    imageUrl: null, docName: null, docText: null,
    model: null, provider: null,
    tokensIn: null, tokensOut: null, elapsedMs: null, jobId: null,
    createdAt: new Date().toISOString(),
  };

  const placeholders = ids.map(() => '?').join(',');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE chat_messages SET compacted = 1 WHERE messageId IN (${placeholders})`).run(...ids);
    msgInsertStmt.run(summaryRow);
    db.prepare('UPDATE chat_conversations SET updatedAt = ? WHERE chatId = ?')
      .run(summaryRow.createdAt, chatId);
  });
  tx();
  return { compacted: ids.length, summaryMessage: summaryRow };
}

// Used by the worker callback flow: find the conversation a chat_job
// belongs to so we can append the assistant reply.
const jobToChatStmt = db.prepare(
  `SELECT chatId, messageId, model, provider FROM chat_jobs WHERE jobId = ?`
);
export function getJobChat(jobId) {
  return jobToChatStmt.get(jobId) || null;
}

// Look up the persisted assistant message for a finished chat job —
// gives the FE access to the Cloudinary imageUrl that image-gen
// produced, which isn't stored on chat_jobs itself.
const msgByJobStmt = db.prepare(
  `SELECT messageId, role, content, imageUrl, model, provider
     FROM chat_messages WHERE jobId = ? AND role = 'assistant' LIMIT 1`
);
export function getAssistantMessageByJobId(jobId) {
  return msgByJobStmt.get(jobId) || null;
}
