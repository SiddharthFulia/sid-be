#!/usr/bin/env node
// One-off migration: adds missing indexes identified in the query audit.
//
// Not required at runtime. Run manually on Oracle after deploy:
//   cd /home/ubuntu/sid-be && node db/indexes/apply-indexes.js
//
// Every statement is CREATE INDEX IF NOT EXISTS. Idempotent + safe to re-run.
//
// Group indexes by domain so a failure inside one group doesn't block the
// others. Prints a per-index PASS/SKIP/FAIL summary at the end.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'sid.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`No DB at ${DB_PATH} — cd into sid-be root and re-run.`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Each entry: [tableName, indexName, ddl]. Table exists check happens per row
// so a fresh dev DB missing e.g. cinema_projects doesn't nuke the whole run.
const INDEXES = [
  // AI Video
  ['jobs', 'idx_jobs_vault_created',
    'CREATE INDEX IF NOT EXISTS idx_jobs_vault_created ON jobs(vault, createdAt DESC)'],
  ['videos', 'idx_videos_vault_created',
    'CREATE INDEX IF NOT EXISTS idx_videos_vault_created ON videos(vault, createdAt DESC)'],
  ['combined_videos', 'idx_combined_videos_vault_created',
    'CREATE INDEX IF NOT EXISTS idx_combined_videos_vault_created ON combined_videos(vault, createdAt DESC)'],

  // Images
  ['enhanced_images', 'idx_enh_vault_completed_created',
    "CREATE INDEX IF NOT EXISTS idx_enh_vault_completed_created ON enhanced_images(vault, status, createdAt DESC)"],
  ['enhanced_images', 'idx_enh_workflow_created',
    'CREATE INDEX IF NOT EXISTS idx_enh_workflow_created ON enhanced_images(workflow, createdAt DESC)'],

  // Chat
  ['chat_conversations', 'idx_chat_conv_pinned_updated',
    'CREATE INDEX IF NOT EXISTS idx_chat_conv_pinned_updated ON chat_conversations(pinned DESC, archived, updatedAt DESC)'],
  ['chat_messages', 'idx_chat_msgs_job',
    'CREATE INDEX IF NOT EXISTS idx_chat_msgs_job ON chat_messages(jobId)'],
  ['chat_jobs', 'idx_chat_jobs_chat',
    'CREATE INDEX IF NOT EXISTS idx_chat_jobs_chat ON chat_jobs(chatId, createdAt DESC)'],

  // Mesh
  ['mesh_jobs', 'idx_mesh_model_status_created',
    'CREATE INDEX IF NOT EXISTS idx_mesh_model_status_created ON mesh_jobs(model, status, createdAt DESC)'],

  // Audio / Deepfake / Lip Sync
  ['audio_jobs', 'idx_audio_vault_status',
    'CREATE INDEX IF NOT EXISTS idx_audio_vault_status ON audio_jobs(vault, status, createdAt DESC)'],

  // Room
  ['room_jobs', 'idx_room_worker_status',
    'CREATE INDEX IF NOT EXISTS idx_room_worker_status ON room_jobs(workerId, status)'],

  // Cinema
  ['cinema_projects', 'idx_cinema_projects_vault_created',
    'CREATE INDEX IF NOT EXISTS idx_cinema_projects_vault_created ON cinema_projects(vault, createdAt DESC)'],
  ['job_logs', 'idx_job_logs_render',
    'CREATE INDEX IF NOT EXISTS idx_job_logs_render ON job_logs(cinemaRenderId, ts ASC)'],

  // Chess
  ['chess_games', 'idx_chess_games_collection_updated',
    'CREATE INDEX IF NOT EXISTS idx_chess_games_collection_updated ON chess_games(collection, updatedAt DESC)'],
  ['chess_matches', 'idx_chess_matches_white_session',
    'CREATE INDEX IF NOT EXISTS idx_chess_matches_white_session ON chess_matches(whiteSession)'],
  ['chess_matches', 'idx_chess_matches_black_session',
    'CREATE INDEX IF NOT EXISTS idx_chess_matches_black_session ON chess_matches(blackSession)'],
  ['chess_puzzle_attempts', 'idx_attempts_user_created',
    'CREATE INDEX IF NOT EXISTS idx_attempts_user_created ON chess_puzzle_attempts(user_id, created_at DESC)'],
];

function tableExists(name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name);
  return !!row;
}

const results = { pass: [], skip: [], fail: [] };

for (const [table, indexName, ddl] of INDEXES) {
  if (!tableExists(table)) {
    results.skip.push(`${indexName} (table ${table} missing)`);
    continue;
  }
  try {
    db.exec(ddl);
    results.pass.push(indexName);
  } catch (err) {
    results.fail.push(`${indexName}: ${err.message}`);
  }
}

console.log('\n── apply-indexes ────────────────────────────────');
console.log(`  passed: ${results.pass.length}`);
for (const n of results.pass) console.log(`    ✓ ${n}`);
if (results.skip.length) {
  console.log(`  skipped: ${results.skip.length}`);
  for (const n of results.skip) console.log(`    · ${n}`);
}
if (results.fail.length) {
  console.log(`  failed: ${results.fail.length}`);
  for (const n of results.fail) console.log(`    ✗ ${n}`);
  process.exitCode = 1;
}

db.close();
