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

export async function checkHealth() {
  const res = await fetch(`${FACE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}
