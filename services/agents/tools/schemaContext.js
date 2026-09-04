// Live schema + per-table curated context for agent prompts.
// Thin re-export layer — see dbExplorer.js for the actual cache + prompt
// builder. Kept here so agent code imports "tools/*" without reaching into
// admin/.

export { listTables, browseTable } from '../../admin/dbExplorer.js';
export { getTableContext, TABLE_CONTEXT } from '../../admin/dbContextConstants.js';
