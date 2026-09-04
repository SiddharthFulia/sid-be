// Re-export of dbExplorer's SQL safety layer, so agent code doesn't have to
// know that the canonical implementation lives under services/admin/.
//
// If we ever move the read-only handle + regex vetter into agents/tools/,
// this file becomes the actual implementation and dbExplorer imports from
// here. Kept as a re-export today so both call sites converge cleanly.

export { vetSql, runSelect } from '../../admin/dbExplorer.js';
