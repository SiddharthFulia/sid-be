// db-query agent — Groq NL → read-only SELECT on sid.db.
//
// Delegates to the existing services/admin/dbExplorer.js. This file is the
// pf-agents-shaped facade; the actual guardrails + Groq prompt live in
// dbExplorer.js and are shared with the /api/admin/db/ask route.

import { askGroqForSql } from '../admin/dbExplorer.js';
import { vetSql, runSelect } from './tools/sqlSafety.js';

export const spec = {
  id: 'db-query',
  purpose: 'Read-only SELECT on sid.db, driven by a natural-language question. Optionally focus on one table for a tighter prompt.',
  auth: 'vault',
  input: {
    question:   'string',
    focusTable: 'string?',
    execute:    'string?',  // '1' | 'true' → run the SQL. Otherwise dry-run.
  },
  output: {
    sql:         'string',
    explanation: 'string',
    chart:       'object?',
    rows:        'array?',
    columns:     'array?',
    rowCount:    'number?',
    durationMs:  'number?',
    model:       'string',
  },
};

export async function run(input, ctx = {}) {
  const question = String(input?.question || '').trim();
  if (!question) {
    const e = new Error('question is required');
    e.status = 400;
    throw e;
  }
  const focusTable = input?.focusTable ? String(input.focusTable) : null;
  const execute = input?.execute === '1' || input?.execute === 'true' || input?.execute === true;

  // 1. Groq: NL → { sql, explanation, chart }
  const proposal = await askGroqForSql(question, { focusTable });

  // 2. Safety: reject non-SELECT, comments, multi-statements. Injects LIMIT
  //    if none supplied.
  const vet = vetSql(proposal.sql);
  if (!vet.ok) {
    return {
      sql:         proposal.sql,
      explanation: proposal.explanation,
      chart:       proposal.chart,
      model:       proposal.model,
      rejected:    vet.reason,
    };
  }

  const base = {
    sql:         vet.sql,
    explanation: proposal.explanation,
    chart:       proposal.chart,
    model:       proposal.model,
  };

  // 3. Dry-run mode returns the SQL without touching the DB. Handy for
  //    UI preview flows or when a caller wants to inspect + edit first.
  if (!execute) return base;

  // 4. Execute — readonly connection + SAVEPOINT belt-and-suspenders.
  const result = runSelect(vet.sql);
  return {
    ...base,
    rows:       result.rows,
    columns:    result.columns,
    rowCount:   result.rowCount,
    durationMs: result.durationMs,
  };
}
