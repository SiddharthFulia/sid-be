// ZSky uses Supabase Auth (https://auth.zsky.ai) for sessions.
// Free account flow:
//   1) User logs in once on zsky.ai
//   2) User copies refresh_token from DevTools → pastes into ZSKY_REFRESH_TOKEN
//   3) This module mints fresh access tokens via Supabase whenever needed,
//      rotates the refresh_token (Supabase rotates on each refresh), and
//      persists the rotated tokens to data/zsky-tokens.json so the next
//      restart doesn't need a fresh paste.
//
// Once it's working, the BE auto-refreshes for ~30 days. After that, if
// Supabase invalidates the refresh chain, user re-pastes once.

import fs from 'fs/promises';
import path from 'path';
import { ZSKY_REFRESH_TOKEN, ZSKY_ACCESS_TOKEN } from '../../helpers/constants.js';
import logger from '../../helpers/logger.js';

const SUPABASE_URL = 'https://auth.zsky.ai';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlya2ZwdXRrdmlvanNodG5ndXd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzNDE5NjIsImV4cCI6MjA3ODkxNzk2Mn0.YU4LUdgrjNN5SDvB4E3XNNZvxeel3l5BhxtJaAwt2pc';

const TOKENS_FILE = path.join(process.cwd(), 'data', 'zsky-tokens.json');
const REFRESH_BUFFER_SEC = 60;

let memCache = null;
let _initialized = false;

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(TOKENS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.refresh_token) return parsed;
  } catch {}
  return null;
}

async function saveToDisk(tokens) {
  try {
    await fs.mkdir(path.dirname(TOKENS_FILE), { recursive: true });
    await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (e) {
    logger.warn(`Failed to persist ZSky tokens: ${e.message}`);
  }
}

async function init() {
  if (_initialized) return;
  _initialized = true;

  const fromDisk = await loadFromDisk();
  if (fromDisk) {
    memCache = fromDisk;
    return;
  }
  if (ZSKY_REFRESH_TOKEN) {
    memCache = {
      refresh_token: ZSKY_REFRESH_TOKEN,
      access_token: ZSKY_ACCESS_TOKEN || null,
      expires_at: 0,
    };
  }
}

async function callRefresh(refreshToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    const err = new Error(`Supabase token refresh failed (${res.status}): ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user_id: data.user?.id || null,
    refreshed_at: new Date().toISOString(),
  };
}

export function isConfigured() {
  return !!(ZSKY_REFRESH_TOKEN || (memCache && memCache.refresh_token));
}

export async function getAccessToken({ force = false } = {}) {
  await init();

  const now = Math.floor(Date.now() / 1000);
  if (!force && memCache?.access_token && memCache.expires_at - REFRESH_BUFFER_SEC > now) {
    return memCache.access_token;
  }

  const refreshToken = memCache?.refresh_token || ZSKY_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      'ZSky not configured — log in at zsky.ai, copy refresh_token from DevTools (Application → Local Storage → sb-yrkfputkviojshtnguwt-auth-token), paste into ZSKY_REFRESH_TOKEN in sid-be/.env'
    );
  }

  const fresh = await callRefresh(refreshToken);
  memCache = fresh;
  await saveToDisk(fresh);
  logger.info(`ZSky token refreshed — expires at ${new Date((fresh.expires_at || 0) * 1000).toISOString()}`);
  return fresh.access_token;
}

export async function forceRefresh() {
  return getAccessToken({ force: true });
}

export async function tokenInfo() {
  await init();
  if (!memCache) return null;
  return {
    hasAccess: !!memCache.access_token,
    hasRefresh: !!memCache.refresh_token,
    expiresAt: memCache.expires_at ? new Date(memCache.expires_at * 1000).toISOString() : null,
    refreshedAt: memCache.refreshed_at || null,
  };
}
