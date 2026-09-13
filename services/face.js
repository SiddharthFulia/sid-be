// Thin wrappers around the Python face-service (port 5000 local, same host
// on Oracle behind PM2). Every endpoint is idempotent and the caller side
// (controllers/vision, controllers/tattoo) handles rate-limit + cache.
//
// Light lanes (always available on any face-service build):
//   • analyzeFace         — MediaPipe Face Mesh
//   • detectObjects       — YOLOv8 (n or s) ONNX
//   • ocrImage            — Tesseract
//   • dominantColors      — k-means k=6
//   • offlineVisionAnalyze — omnibus of the four above
//
// Deep lanes (added 2026-09-13 — lazy-loaded on the Python side, first hit
// downloads multi-GB weights → 5-10 min cold start, warm thereafter):
//   • captionImage        — BLIP-1 base
//   • clipTags            — CLIP ViT-B/32 zero-shot
//   • faceEmbed           — InsightFace buffalo_s 512-dim embedding + age/gender
//   • faceVerify          — cosine similarity between two face embeddings
//   • paddleOcr           — PaddleOCR PP-OCRv4 (better than Tesseract)
//   • depthMap            — Depth-Anything-V2-Small
//   • deepVisionAnalyze   — omnibus of ALL lanes (caption + tags + everything)
//
// Timeouts are generous — the deep lanes are CPU-only on an ARM box, so a
// 4K image caption can take 6-8 seconds warm and > 5 minutes cold.

import { FACE_SERVICE_URL } from '../helpers/constants.js';

const DEEP_TIMEOUT_MS = 300_000;   // 5 min — covers cold-load weight downloads
const OMNIBUS_TIMEOUT_MS = 360_000; // 6 min — same, plus five lanes in one call

async function _post(path, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${FACE_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} error: ${res.status}`);
  return res.json();
}

// ─── LIGHT LANES ─────────────────────────────────────────────────

export async function analyzeFace(imageData) {
  return _post('/analyze', { image: imageData }, { timeoutMs: 30_000 });
}

export async function detectObjects(imageData, threshold = 0.5) {
  return _post('/detect-objects', { image: imageData, threshold }, { timeoutMs: 30_000 });
}

export async function ocrImage(imageData, timeoutMs = 15_000) {
  return _post('/ocr', { image: imageData }, { timeoutMs });
}

export async function dominantColors(imageData, k = 6, timeoutMs = 8_000) {
  return _post('/dominant-colors', { image: imageData, k }, { timeoutMs });
}

export async function offlineVisionAnalyze(imageData, { threshold = 0.5, k = 6 } = {}, timeoutMs = 30_000) {
  return _post('/vision-analyze', { image: imageData, threshold, k }, { timeoutMs });
}

// ─── DEEP LANES ──────────────────────────────────────────────────

export async function captionImage(imageData, { timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  return _post('/caption', { image: imageData }, { timeoutMs });
}

export async function clipTags(imageData, labels, { top_k = 5, timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  return _post('/clip-tags', { image: imageData, labels, top_k }, { timeoutMs });
}

export async function faceEmbed(imageData, { includeEmbedding = true, timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  return _post('/face-embed', { image: imageData, include_embedding: includeEmbedding }, { timeoutMs });
}

export async function faceVerify(imageA, imageB, { threshold = 0.5, timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  return _post('/face-verify', { imageA, imageB, threshold }, { timeoutMs });
}

export async function paddleOcr(imageData, { timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  return _post('/paddle-ocr', { image: imageData }, { timeoutMs });
}

export async function depthMap(imageData, { timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  return _post('/depth-map', { image: imageData }, { timeoutMs });
}

// Subject extraction — pure OpenCV, fast (no model weights needed for
// `auto` / `dark`). `depth` mode piggybacks on Depth-Anything if it's loaded.
export async function extractSubject(imageData, { mode = 'auto', timeoutMs = 30_000 } = {}) {
  return _post('/extract-subject', { image: imageData, mode }, { timeoutMs });
}

// The deep omnibus — one call, all deep + light lanes. First hit on a fresh
// Python service takes several minutes (weight downloads); warm hits are
// 3-8 seconds on the ARM box.
export async function deepVisionAnalyze(
  imageData,
  { threshold = 0.5, k = 6, top_k = 8, labels = null, skip = null, includeEmbedding = false } = {},
  timeoutMs = OMNIBUS_TIMEOUT_MS,
) {
  const body = { image: imageData, threshold, k, top_k, include_embedding: includeEmbedding };
  if (labels) body.labels = labels;
  if (skip) body.skip = skip;
  return _post('/vision-deep', body, { timeoutMs });
}

// ─── HEALTH ──────────────────────────────────────────────────────

export async function checkHealth() {
  const res = await fetch(`${FACE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}

// Fetch the raw health JSON so admin UIs can show which deep models are hot.
export async function fetchHealthDetail() {
  const res = await fetch(`${FACE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`face-service /health ${res.status}`);
  return res.json();
}
