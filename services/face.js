import { FACE_SERVICE_URL } from '../helpers/constants.js';

export async function analyzeFace(imageData) {
  const res = await fetch(`${FACE_SERVICE_URL}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageData }),
  });

  if (!res.ok) throw new Error(`Face service error: ${res.status}`);
  return res.json();
}

export async function detectObjects(imageData, threshold = 0.5) {
  const res = await fetch(`${FACE_SERVICE_URL}/detect-objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageData, threshold }),
  });
  if (!res.ok) throw new Error(`Object detection error: ${res.status}`);
  return res.json();
}

export async function checkHealth() {
  const res = await fetch(`${FACE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}

// Individual "offline vision" lanes. Each one is wired into
// /api/vision/analyze via Promise.allSettled so a single lane failing
// doesn't kill the whole response. All accept a base64 or data-URI string.

export async function ocrImage(imageData, timeoutMs = 15000) {
  const res = await fetch(`${FACE_SERVICE_URL}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageData }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OCR error: ${res.status}`);
  return res.json();
}

export async function dominantColors(imageData, k = 6, timeoutMs = 8000) {
  const res = await fetch(`${FACE_SERVICE_URL}/dominant-colors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageData, k }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Dominant colors error: ${res.status}`);
  return res.json();
}

// Omnibus offline analyze. The Python service runs all four lanes in-process
// (no HTTP hop between them) so we prefer this over four separate calls when
// available — falls back to the parallel-fetch path if this endpoint 404s.
export async function offlineVisionAnalyze(imageData, { threshold = 0.5, k = 6 } = {}, timeoutMs = 30000) {
  const res = await fetch(`${FACE_SERVICE_URL}/vision-analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageData, threshold, k }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Offline vision analyze error: ${res.status}`);
  return res.json();
}
