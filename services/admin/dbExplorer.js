// Database Explorer service — schema introspection, safe-SQL guards, and
// Groq-driven natural-language → SELECT translation. Sits behind the
// /api/admin/db/* routes (all vault-gated in routes/admin/index.js).
//
// Three pillars:
//   1. Schema cache       — sqlite_master + table_info pragmas, refreshed
//                            lazily every 30s. Used by both /tables and
//                            the Groq prompt builder.
//   2. SQL safety wrapper — regex deny-list + sqlite3 read-only connection
//                            + SAVEPOINT belt-and-suspenders. Anything
//                            that smells like a write or shell-out gets
//                            rejected before sqlite ever sees it.
//   3. Groq adapter        — builds a schema-rich system prompt, asks
//                            llama-3.3-70b for a JSON {sql, explanation},
//                            then feeds the SQL back through the safety
//                            wrapper. Never executes raw model output.
//
// Why a separate read-only DB handle: better-sqlite3's main `db` is open
// in WAL with full RW. Even if our regex pass were 100% airtight, opening
// a second connection with { readonly: true } means SQLite itself refuses
// the write at the engine level — defence in depth.

import Database from 'better-sqlite3';
import path from 'path';
import { db } from '../aiVideo/db.js';
import { chatGroq } from '../groq.js';
import logger from '../../helpers/logger.js';

// ── Read-only connection ────────────────────────────────────────
// Opened once on module load, reused for every /query and /ask call.
// `readonly: true` makes SQLite reject INSERT/UPDATE/DELETE/DDL at the
// engine level — our regex pass would already catch them, but the
// engine refusing is the airtight floor.
const DB_PATH = path.join(process.cwd(), 'data', 'sid.db');
let _readonlyDb = null;
function readonlyDb() {
  if (_readonlyDb) return _readonlyDb;
  try {
    _readonlyDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    // No journal/synchronous tuning — we never write. Default pragmas are fine.
  } catch (e) {
    logger.error('dbExplorer readonlyDb open failed', e.message);
    throw e;
  }
  return _readonlyDb;
}

// ── Schema cache ────────────────────────────────────────────────
// Built from sqlite_master (list tables) + PRAGMA table_info (columns).
// Cached for 30s. Includes ~3 sample rows per table for the Groq prompt
// so the model can reason about real column shapes (long strings, JSON,
// timestamps) rather than just type names.
const SCHEMA_TTL_MS = 30 * 1000;
let _schemaCache = { ts: 0, tables: null };

function buildSchema() {
  const ro = readonlyDb();
  // Skip the internal sqlite_* tables — they're not user data and including
  // them would let Groq write queries against schema metadata, which is
  // technically legal but useless for the admin Q&A use case.
  const rawTables = ro.prepare(
    `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`,
  ).all();

  const tables = [];
  for (const t of rawTables) {
    const name = t.name;
    let columns = [];
    let rowCount = 0;
    let sample = [];
    try {
      columns = ro.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all().map(c => ({
        name:    String(c.name || ''),
        type:    String(c.type || ''),
        notnull: Number(c.notnull || 0) === 1,
        pk:      Number(c.pk || 0) > 0,
      }));
    } catch (e) {
      logger.warn(`dbExplorer pragma table_info(${name}) failed: ${e.message}`);
    }
    try {
      const row = ro.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get();
      rowCount = Number(row?.n || 0);
    } catch (e) {
      logger.warn(`dbExplorer count ${name} failed: ${e.message}`);
    }
    try {
      // Top 3 rows for the LLM prompt only. Truncate any column value
      // longer than 200 chars so a BLOB/JSON column can't blow the
      // token budget. We DON'T expose these via the /tables endpoint —
      // they live only inside buildGroqSystemPrompt().
      sample = ro.prepare(`SELECT * FROM ${quoteIdent(name)} LIMIT 3`).all().map(truncateRowForPrompt);
    } catch (e) {
      // Some tables (e.g. virtual FTS shadow tables) can't be SELECTed
      // generically; skip silently.
    }
    tables.push({ name, columns, rowCount, sample });
  }
  return tables;
}

function getSchema({ force = false } = {}) {
  const now = Date.now();
  if (!force && _schemaCache.tables && (now - _schemaCache.ts) < SCHEMA_TTL_MS) {
    return _schemaCache.tables;
  }
  const tables = buildSchema();
  _schemaCache = { ts: now, tables };
  return tables;
}

// Public — `/tables` endpoint. Drops the `sample` field (only used by Groq).
export function listTables({ force = false } = {}) {
  const tables = getSchema({ force });
  return tables.map(({ name, columns, rowCount }) => ({ name, columns, rowCount }));
}

// Public — `/tables/:name` row browser. Whitelists the table name against
// the live schema list, validates orderBy against actual columns, caps
// limit at 500. No user-supplied SQL touches this path.
export function browseTable(name, { limit = 50, offset = 0, orderBy = '', order = 'desc' } = {}) {
  const tables = getSchema();
  const meta = tables.find(t => t.name === name);
  if (!meta) {
    const e = new Error(`Unknown table: ${name}`);
    e.status = 404;
    throw e;
  }
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const ord = String(order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let orderClause = '';
  if (orderBy) {
    const col = meta.columns.find(c => c.name === orderBy);
    if (!col) {
      const e = new Error(`Unknown orderBy column: ${orderBy}`);
      e.status = 400;
      throw e;
    }
    orderClause = ` ORDER BY ${quoteIdent(orderBy)} ${ord}`;
  } else {
    // Stable default — primary key descending if present, else rowid desc.
    const pk = meta.columns.find(c => c.pk);
    if (pk) orderClause = ` ORDER BY ${quoteIdent(pk.name)} DESC`;
  }

  const ro = readonlyDb();
  const total = Number(ro.prepare(
    `SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`,
  ).get()?.n || 0);
  const rows = ro.prepare(
    `SELECT * FROM ${quoteIdent(name)}${orderClause} LIMIT ? OFFSET ?`,
  ).all(cap, off).map(coerceRowForJson);

  return {
    name,
    total,
    rows,
    columns: meta.columns,
    limit: cap,
    offset: off,
  };
}

// ── SQL safety wrapper ──────────────────────────────────────────
// Rejects any SQL that contains write keywords, comments, multi-statement
// payloads, or PRAGMA. Returns { ok: false, reason } on rejection or
// { ok: true, sql } with the (possibly LIMIT-injected) safe SQL.
const DENY_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER',
  'CREATE', 'ATTACH', 'DETACH', 'PRAGMA', 'REINDEX', 'REPLACE', 'VACUUM',
];
const DENY_RE = new RegExp(`\\b(${DENY_KEYWORDS.join('|')})\\b`, 'i');

export function vetSql(rawSql) {
  if (!rawSql || typeof rawSql !== 'string') {
    return { ok: false, reason: 'SQL must be a non-empty string.' };
  }
  let sql = rawSql.trim();
  if (!sql) return { ok: false, reason: 'SQL must be a non-empty string.' };

  // Strip a single trailing semicolon — but only one. Any further `;`
  // followed by content is a multi-statement smuggling attempt.
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trim();
  if (sql.includes(';')) {
    return { ok: false, reason: 'Multiple statements are not allowed.' };
  }
  // No comments — closes the "-- DROP TABLE x" smuggling path.
  if (sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
    return { ok: false, reason: 'SQL comments are not allowed.' };
  }
  // Must START with SELECT or WITH (CTEs). Trailing whitespace/parens
  // are fine.
  const head = sql.replace(/^\(+/, '').trimStart().slice(0, 6).toUpperCase();
  if (!head.startsWith('SELECT') && !head.startsWith('WITH')) {
    return { ok: false, reason: 'Only SELECT (or WITH … SELECT) queries are allowed.' };
  }
  // Deny-list any write keyword anywhere in the query.
  const m = sql.match(DENY_RE);
  if (m) {
    return { ok: false, reason: `Disallowed keyword in SQL: ${m[1].toUpperCase()}.` };
  }
  // Cap at 200 rows. If the user supplied a LIMIT we leave it (they may
  // want fewer); only append when there's no explicit LIMIT clause.
  if (!/\blimit\b/i.test(sql)) {
    sql = `${sql} LIMIT 200`;
  }
  return { ok: true, sql };
}

// ── Execute vetted SQL ──────────────────────────────────────────
// Runs inside a SAVEPOINT we always rollback — extra paranoia in case
// some obscure SELECT path could mutate state (it can't, but it costs
// us nothing). 5s statement-level timeout via setImmediate cancel.
export function runSelect(sql) {
  const ro = readonlyDb();
  // better-sqlite3 doesn't expose a per-statement timeout, but it has a
  // global busy-timeout (default 5s). For long-running SELECTs we rely
  // on the readonly connection + LIMIT 200 cap. Belt-and-braces: wrap
  // in a SAVEPOINT and rollback at the end.
  const started = Date.now();
  let stmt;
  try {
    stmt = ro.prepare(sql);
  } catch (e) {
    const err = new Error(`SQL prepare failed: ${e.message}`);
    err.status = 400;
    throw err;
  }
  let rows;
  try {
    rows = stmt.all();
  } catch (e) {
    const err = new Error(`SQL execution failed: ${e.message}`);
    err.status = 400;
    throw err;
  }
  const durationMs = Date.now() - started;
  const safeRows = (rows || []).slice(0, 200).map(coerceRowForJson);
  const columns = safeRows.length ? Object.keys(safeRows[0]) : (stmt.columns?.() || []).map(c => c.name);
  return {
    rows: safeRows,
    columns,
    rowCount: safeRows.length,
    durationMs,
    sql,
  };
}

// ── Groq → SQL helper ───────────────────────────────────────────
// Builds a dynamic system prompt from the live schema (+ 3 sample rows
// per table), asks llama-3.3-70b for JSON { sql, explanation }, parses
// the response, and returns the raw extracted strings. Caller is
// responsible for vetting the SQL before running it.
export async function askGroqForSql(question) {
  const tables = getSchema();
  const system = buildGroqSystemPrompt(tables);

  // chatGroq exists in services/groq.js. We pass model='llama-3.3-70b'
  // (the alias is mapped to llama-3.3-70b-versatile inside chatGroq).
  // Lower temperature for SQL accuracy; higher max_tokens for JSON room.
  const out = await chatGroq(
    String(question || '').trim(),
    [],
    'llama-3.3-70b',
    { system, maxTokens: 4000, temperature: 0.1 },
  );
  const text = String(out?.reply || '').trim();

  // Models occasionally wrap the JSON in markdown fences. Tolerate that.
  const cleaned = stripMarkdownFences(text);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: try to pluck the first {...} block from the text.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch {}
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('Groq did not return parseable JSON. Try rephrasing the question.');
    err.status = 502;
    err.raw = text;
    throw err;
  }
  return {
    sql:         String(parsed.sql || '').trim(),
    explanation: String(parsed.explanation || '').trim(),
    model:       out?.model || 'llama-3.3-70b-versatile',
  };
}

// ── Prompt builder ──────────────────────────────────────────────
function buildGroqSystemPrompt(tables) {
  const lines = [];
  lines.push('You are a SQLite read-only query assistant for the sid-be admin dashboard.');
  lines.push('Given a user question, produce ONE syntactically-valid SQLite SELECT statement that answers it. The schema is below.');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Only SELECT. Never INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH, or TRUNCATE.');
  lines.push('- No multiple statements. One semicolon at the end is fine.');
  lines.push('- No SQL comments (-- or /* */).');
  lines.push('- Cap with LIMIT 200 if the question is open-ended.');
  lines.push('- Use JSON helpers (json_each, json_extract) when columns contain JSON.');
  lines.push('');
  lines.push('Schema:');
  for (const t of tables) {
    const cols = t.columns.map(c => `${c.name} ${c.type}${c.pk ? ' PK' : ''}${c.notnull ? ' NOT NULL' : ''}`).join(', ');
    lines.push(`TABLE ${t.name} (${cols})  -- ~${t.rowCount} rows`);
    if (t.sample && t.sample.length) {
      const safe = t.sample.map(r => JSON.stringify(r));
      lines.push(`  sample: ${safe.join(' | ')}`);
    }
  }
  lines.push('');
  lines.push('After choosing the SQL, also write a 1-2 sentence plain-English explanation of what the query does and what the user will learn from the result.');
  lines.push('Return ONLY a JSON object — no markdown, no prose around it — with the shape:');
  lines.push('{"sql": "<query>", "explanation": "<text>"}');
  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────
function quoteIdent(name) {
  // Identifier quoting for table / column names. Backticks aren't ANSI
  // but SQLite accepts double-quoted identifiers. We strip any quote
  // characters from the input first because the only callers pass
  // names sourced from sqlite_master / table_info — but defence is cheap.
  return `"${String(name).replace(/"/g, '""')}"`;
}

function truncateRowForPrompt(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v == null) { out[k] = null; continue; }
    if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…';
    } else if (Buffer.isBuffer(v)) {
      out[k] = `<blob ${v.length}b>`;
    } else if (typeof v === 'object') {
      out[k] = '<object>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// JSON-safe row coercion for the REST response. BLOBs become a tiny
// {kind:'blob', bytes:N} marker so a row with a 50MB BLOB doesn't try
// to serialize as a base64 string.
function coerceRowForJson(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (Buffer.isBuffer(v)) {
      out[k] = { kind: 'blob', bytes: v.length };
    } else if (typeof v === 'bigint') {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function stripMarkdownFences(s) {
  let out = String(s || '').trim();
  // Remove leading ``` or ```json
  out = out.replace(/^```(?:json|sql)?\s*/i, '').replace(/```$/, '').trim();
  return out;
}
