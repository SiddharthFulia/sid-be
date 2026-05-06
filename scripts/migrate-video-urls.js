#!/usr/bin/env node
// Idempotent migration: fixes legacy generated-videos.json records
//   - adds missing `status: 'completed'` for records that have a videoUrl
//   - rewrites root-path videoUrls (/generated-videos/vid_xxx.mp4) to
//     subfolder-path (/generated-videos/<provider>/vid_xxx.mp4) IF the file
//     actually exists at the subfolder path on disk.
//
// Run from sid-be root:   node scripts/migrate-video-urls.js
// Safe to run repeatedly — only writes if changes were made.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const META_FILE = path.join(ROOT, 'data', 'generated-videos.json');
const VIDEOS_DIR = path.join(ROOT, 'public', 'generated-videos');

function loadMeta() {
  if (!fs.existsSync(META_FILE)) return [];
  try {
    const raw = fs.readFileSync(META_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Failed to read metadata:', e.message);
    process.exit(1);
  }
}

function saveMeta(items) {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function migrate() {
  const items = loadMeta();
  if (items.length === 0) {
    console.log('No records to migrate.');
    return 0;
  }

  let changed = 0;

  for (const item of items) {
    let touched = false;

    // 1. Backfill status for legacy records that obviously completed.
    if (!item.status && item.videoUrl) {
      item.status = 'completed';
      if (!item.completedAt) item.completedAt = item.createdAt || new Date().toISOString();
      touched = true;
    }

    // 2. Fix videoUrl path if file moved into a provider subfolder.
    const url = item.videoUrl || '';
    const m = url.match(/^\/generated-videos\/(vid_[A-Za-z0-9_-]+\.\w+)$/);
    if (m && item.provider) {
      const filename = m[1];
      const rootPath = path.join(VIDEOS_DIR, filename);
      const subPath = path.join(VIDEOS_DIR, item.provider, filename);
      // If file is missing at root but present in provider subfolder, rewrite URL.
      if (!fileExists(rootPath) && fileExists(subPath)) {
        item.videoUrl = `/generated-videos/${item.provider}/${filename}`;
        touched = true;
      }
    }

    if (touched) changed++;
  }

  if (changed === 0) {
    console.log(`No changes needed (${items.length} records).`);
    return 0;
  }

  saveMeta(items);
  console.log(`Migrated ${changed}/${items.length} records.`);
  return changed;
}

migrate();
