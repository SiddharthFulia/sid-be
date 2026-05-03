import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const ROOT = process.cwd();
export const VIDEO_DIR = path.join(ROOT, 'public', 'generated-videos');
export const META_DIR = path.join(ROOT, 'data');
export const META_FILE = path.join(META_DIR, 'generated-videos.json');

async function ensureDirs() {
  await fs.mkdir(VIDEO_DIR, { recursive: true });
  await fs.mkdir(META_DIR, { recursive: true });
}

export function newVideoId() {
  return `vid_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export async function saveVideoBuffer(buffer, videoId, ext = 'mp4') {
  await ensureDirs();
  const filename = `${videoId}.${ext}`;
  const fullPath = path.join(VIDEO_DIR, filename);
  await fs.writeFile(fullPath, buffer);
  return {
    filename,
    fullPath,
    publicPath: `/generated-videos/${filename}`,
  };
}

async function readMeta() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(META_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMeta(items) {
  await ensureDirs();
  await fs.writeFile(META_FILE, JSON.stringify(items, null, 2), 'utf8');
}

export async function saveVideoMetadata(record) {
  const items = await readMeta();
  items.unshift(record);
  await writeMeta(items.slice(0, 100));
  return record;
}

export async function getLatestVideo() {
  const items = await readMeta();
  return items[0] || null;
}

export async function getRecentVideos(limit = 12) {
  const items = await readMeta();
  return items.slice(0, limit);
}
