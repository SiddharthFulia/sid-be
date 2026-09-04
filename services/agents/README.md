# services/agents

Groq-powered agents, in the pf-agents shape.

## Why this exists

`services/admin/dbExplorer.js` already ships a production-grade NL → SQL
pipeline. This folder wraps it under a common agent registry so we can add
future agents (marketing content, DBA advisor, log summarizer, …) without
copy-pasting the Groq call + guardrails each time.

## Shape

Every agent exposes:

```js
export const spec = {
  id: 'db-query',                    // machine name — matches the route
  purpose: 'Read-only SQL against sid.db, driven by NL questions.',
  auth:    'vault',                  // 'vault' | 'admin' | 'public'
  input:   { question: 'string', focusTable: 'string?' },
  output:  { sql: 'string', rows: 'array', columns: 'array', chart: 'object?' },
};

export async function run(input, ctx) { ... }
```

`ctx` is `{ requestId, logger }` today — reserved for later expansion
(user id, workspace id, quota tracking).

## Available agents

| id | Purpose | Route |
|---|---|---|
| `db-query` | Groq NL → read-only SELECT on sid.db | `POST /api/agents/db-query` |

## Adding a new agent

1. Write `services/agents/<name>Agent.js` with `spec` + `run` exports
2. Register it in `services/agents/index.js`
3. Route lands automatically at `POST /api/agents/<id>` via
   `controllers/agents/index.js`
4. Add a row to the table above + document tools in `tools/`

## Tools

Shared helpers under `services/agents/tools/`:

| File | What |
|---|---|
| `groqLlm.js` | Thin wrapper on `services/groq.js` — retries + JSON parsing |
| `sqlSafety.js` | Re-exports `vetSql` + `runSelect` from `services/admin/dbExplorer.js` |
| `schemaContext.js` | Re-exports `listTables` + `getTableContext` — the schema the LLM sees |
