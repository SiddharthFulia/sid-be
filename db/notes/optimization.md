# Optimization notes

## Why SQLite

- Single file on disk → trivial backup (`scp sid.db off-box`)
- `better-sqlite3` is synchronous + ~50k inserts/sec — well past our load
- Portable schema — the DDL in `services/aiVideo/db.js` runs on Postgres with
  minor tweaks if we ever need to migrate

## Pragmas set at boot

Set in `services/aiVideo/db.js`:

| Pragma | Value | Reason |
|---|---|---|
| `journal_mode` | `WAL` | readers don't block writers (FE polls `/status` while worker writes `/job-progress` every second) |
| `synchronous` | `NORMAL` | pairs safely with WAL — full-fsync every checkpoint is enough |
| `foreign_keys` | `ON` | CASCADE from `chat_conversations` needs it |

## Rules for query authors

1. **Every `WHERE` clause on a large table must hit an index.** Confirm with
   `EXPLAIN QUERY PLAN <sql>` — look for `SEARCH TABLE ... USING INDEX ...`,
   not `SCAN TABLE ...`.
2. **Column order in a composite index matters.** `(status, createdAt DESC)`
   serves `WHERE status = ? ORDER BY createdAt DESC` but NOT
   `WHERE createdAt > ?`.
3. **`LIKE '%foo%'`** cannot use an index. If you need substring search, add a
   dedicated FTS5 virtual table (we do not use one yet).
4. **`ORDER BY` on an unindexed column** forces a sort. Match your ORDER BY to
   the tail of your index (e.g. `idx_jobs_status_created` ends in
   `createdAt DESC`, so `WHERE status=? ORDER BY createdAt DESC` is free).
5. **Partial indexes** (e.g. `WHERE status='completed'`) are the right call
   when a filtered subset is >90% of reads and <20% of writes. We already have
   `idx_enh_completed_created` — mirror the pattern for other Library views if
   the workload tips that way.

## When to add a new index

Add one if a query:

- Runs on every FE page load, and
- Filters a table with >10k rows, and
- Cannot use an existing index (check with `EXPLAIN QUERY PLAN`)

Skip an index if:

- The table is small (<1k rows) — SQLite scans a page or two, done
- The query runs only in admin/debug paths
- Adding it would slow inserts on a write-heavy table without a matching read
  win

## When to update column context for the Groq DB agent

Every new table needs:

1. A block in `services/admin/dbContextConstants.js` (`purpose` + `notes`)
2. A row in this doc under the right domain file (`db/schema/*.md`)

The agent reads the constants at inference time — outdated notes are worse
than missing notes because they mislead the model.
