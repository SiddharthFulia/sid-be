import { GROQ_API_KEY } from '../helpers/constants.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MODELS = {
  'llama-3.1-8b': 'llama-3.1-8b-instant',
  'llama-3.3-70b': 'llama-3.3-70b-versatile',
  'gpt-oss-120b': 'openai/gpt-oss-120b',
};

export async function chatGroq(message, history = [], model = 'llama-3.1-8b', options = {}) {
  if (!GROQ_API_KEY) throw new Error('Groq API key not configured');

  const modelId = MODELS[model] || model;

  const messages = [
    { role: 'system', content: options.system || 'You are a helpful AI assistant. Be concise and direct.' },
    ...history.slice(-6),
    { role: 'user', content: message },
  ];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: options.maxTokens || 500,
      temperature: options.temperature ?? 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq API error: ${res.status}`);
  }

  const data = await res.json();

  return {
    reply: data.choices?.[0]?.message?.content || '',
    model: data.model,
    tokens: data.usage?.completion_tokens,
    totalTokens: data.usage?.total_tokens,
    duration: null,
    provider: 'groq',
  };
}
