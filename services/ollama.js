import { OLLAMA_URL } from '../helpers/constants.js';
import logger from '../helpers/logger.js';

// Preload models into memory on startup (avoids cold start on first request)
const PRELOAD_MODELS = ['phi3:mini', 'llama3.2:1b'];

export async function preloadModels() {
  for (const model of PRELOAD_MODELS) {
    try {
      await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'hi', options: { num_predict: 1 }, keep_alive: '30m' }),
      });
      logger.info(`Model preloaded: ${model}`);
    } catch (err) {
      logger.warn(`Failed to preload ${model}: ${err.message}`);
    }
  }
}

const SYSTEM_PROMPTS = {
  general: 'You are a helpful AI assistant. Answer in 2-3 sentences max. Be direct, no filler.',
  code: 'You are a senior engineer. Give short, correct code. No explanations unless asked.',
  creative: 'You are creative but concise. Max 3 sentences.',
};

export async function chat(message, history = [], model = 'phi3:mini', context = 'general') {
  const systemPrompt = SYSTEM_PROMPTS[context] || SYSTEM_PROMPTS.general;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-4),
    { role: 'user', content: message },
  ];

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, keep_alive: '30m', options: { num_predict: 100, temperature: 0.7 } }),
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

export async function rawQuery(messages, model = 'phi3:mini', options = {}) {
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
