import { OLLAMA_URL } from '../helpers/constants.js';

const SYSTEM_PROMPTS = {
  general: 'You are a helpful, concise AI assistant on Siddharth\'s portfolio website. Keep responses brief and professional.',
  code: 'You are a senior software engineer. Provide concise, correct code solutions. Use modern best practices.',
  creative: 'You are a creative writing assistant. Be imaginative but concise.',
};

export async function chat(message, history = [], model = 'llama3.2:1b', context = 'general') {
  const systemPrompt = SYSTEM_PROMPTS[context] || SYSTEM_PROMPTS.general;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user', content: message },
  ];

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();

  return {
    reply: data.message?.content || '',
    model: data.model,
    tokens: data.eval_count,
    duration: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
  };
}

export async function rawQuery(messages, model = 'llama3.2:3b', options = {}) {
  const { system, maxTokens, temperature } = options;

  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: false,
  };

  if (maxTokens) body.options = { ...body.options, num_predict: maxTokens };
  if (temperature !== undefined) body.options = { ...body.options, temperature };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();

  return {
    reply: data.message?.content || '',
    model: data.model,
    tokens: data.eval_count,
    duration: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
  };
}
