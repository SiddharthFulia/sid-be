// Vault-gated /api/admin/db/* — Database Explorer endpoints.
//
//   GET  /api/admin/db/tables           — list every user table with rowCount
//                                          + column metadata
//   GET  /api/admin/db/tables/:name     — paginated row browser
//   POST /api/admin/db/query            — direct SELECT execution (safety-vetted)
//   POST /api/admin/db/ask              — natural-language Q&A via Groq →
//                                          SELECT, then safety-vetted +
//                                          executed
//
// All four endpoints sit behind requireVault in routes/admin/index.js.
// The heavy lifting (schema cache, SQL safety, Groq call) is in
// services/admin/dbExplorer.js; this file is just the HTTP edge.

import { success, error } from '../../helpers/res_helper.js';
import logger from '../../helpers/logger.js';
import {
  listTables, browseTable, vetSql, runSelect, askGroqForSql,
} from '../../services/admin/dbExplorer.js';

// GET /api/admin/db/tables
// Returns: { tables: [{ name, rowCount, columns: [...] }] }
// Schema cache refreshes every 30s — passing ?refresh=1 forces an immediate
// rebuild (used by the FE's "Refresh schema" button).
export const getTables = async (req, res) => {
  try {
    const force = String(req.query?.refresh || '').trim() === '1';
    const tables = listTables({ force });
    return success(res, { tables });
  } catch (err) {
    logger.error('admin db getTables failed', err.message);
    return error(res, err.message, 500);
  }
};

// GET /api/admin/db/tables/:name?limit=50&offset=0&orderBy=&order=desc
// Paginated row browser. :name is whitelisted against the live table
// list (no SQL injection through the URL). orderBy is whitelisted against
// the actual column list for that table.
export const getTableRows = async (req, res) => {
  try {
    const { name } = req.params;
    const limit   = parseInt(req.query?.limit, 10);
    const offset  = parseInt(req.query?.offset, 10);
    const orderBy = String(req.query?.orderBy || '').trim();
    const order   = String(req.query?.order || 'desc').trim();
    const result  = browseTable(name, { limit, offset, orderBy, order });
    return success(res, result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) logger.error('admin db getTableRows failed', err.message);
    return error(res, err.message, status);
  }
};

// POST /api/admin/db/query  { sql }
// Direct SELECT execution. Runs vetSql first; any rejection returns 400
// with the reason. On success returns { rows, columns, rowCount, durationMs, sql }.
export const postQuery = async (req, res) => {
  try {
    const sql = String(req.body?.sql || '');
    const vet = vetSql(sql);
    if (!vet.ok) {
      return error(res, vet.reason, 400, { sql });
    }
    const out = runSelect(vet.sql);
    return success(res, out);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) logger.error('admin db postQuery failed', err.message);
    return error(res, err.message, status);
  }
};

// POST /api/admin/db/ask  { question }
// 1. Groq builds a SELECT from the user's English question.
// 2. We vet the SQL with the same wrapper as /query.
// 3. If safe, execute. If unsafe, return 400 with { generatedSql, reason }
//    so the FE can show what the model tried.
export const postAsk = async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) {
      return error(res, 'question (string) is required', 400);
    }
    // Optional: scope the Groq prompt to ONE table for massive token
    // savings. The FE sends `table` when the user has a table picked in
    // the explorer; without it, the prompt falls back to the full schema.
    const focusTable = typeof req.body?.table === 'string' && req.body.table.trim()
      ? req.body.table.trim() : null;
    const t0 = Date.now();
    let gen;
    try {
      gen = await askGroqForSql(question, { focusTable });
    } catch (e) {
      logger.error('admin db ask Groq failed', e.message);
      return error(res, e.message || 'Groq query generation failed', e.status || 502);
    }

    const vet = vetSql(gen.sql);
    if (!vet.ok) {
      // Return 400 with the generated SQL so the user can see what the
      // model tried (and refine the question) — but DO NOT execute it.
      return error(res, `Generated SQL was rejected: ${vet.reason}`, 400, {
        generatedSql: gen.sql,
        explanation:  gen.explanation,
        chart:        gen.chart || null,
        reason:       vet.reason,
        model:        gen.model,
      });
    }

    let runResult;
    try {
      runResult = runSelect(vet.sql);
    } catch (e) {
      // SQL parsed past our vetting but SQLite rejected it (e.g. unknown
      // column). Surface the engine error to the user as a 400 alongside
      // the generated SQL so they can refine.
      return error(res, e.message || 'SQL execution failed', 400, {
        generatedSql: vet.sql,
        explanation:  gen.explanation,
        chart:        gen.chart || null,
        model:        gen.model,
      });
    }

    // Final sanity check on the chart spec: drop it if it references
    // columns the executed SELECT didn't actually return (Groq sometimes
    // hallucinates aliases). FE then falls back to the table view.
    const finalChart = chartReferencesColumns(gen.chart, runResult.columns)
      ? gen.chart
      : null;

    return success(res, {
      question,
      generatedSql: vet.sql,
      explanation:  gen.explanation,
      chart:        finalChart,
      model:        gen.model,
      rows:         runResult.rows,
      columns:      runResult.columns,
      rowCount:     runResult.rowCount,
      durationMs:   Date.now() - t0,
    });
  } catch (err) {
    logger.error('admin db postAsk failed', err.message);
    return error(res, err.message, 500);
  }
};

// Guard against Groq returning chart keys that don't actually exist in the
// result set (alias mismatches, hallucinated column names). Returns true if
// the chart spec's xKey and every yKey appear in the executed columns.
function chartReferencesColumns(chart, columns) {
  if (!chart || !Array.isArray(columns) || columns.length === 0) return false;
  const cols = new Set(columns.map(c => String(c)));
  if (!cols.has(String(chart.xKey))) return false;
  for (const y of chart.yKeys || []) {
    if (!cols.has(String(y))) return false;
  }
  return true;
}
