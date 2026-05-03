import { GROQ_API_KEY } from '../../helpers/constants.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export async function generateGroqCaption(prompt) {
  if (!GROQ_API_KEY) return null;

  const sys = 'You write short, viral Instagram Reel captions. Always include 5 relevant hashtags at the end. Keep the caption under 2 lines. Use 1-2 emojis. No quotes around the output.';
  const user = `Write a viral Instagram Reel caption for this AI video prompt: "${prompt}"`;

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        max_tokens: 220,
        temperature: 0.85,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    return text || null;
  } catch {
    return null;
  }
}
