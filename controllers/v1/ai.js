import { success, error } from '../../helpers/res_helper.js';
import { chat, rawQuery } from '../../services/ollama.js';
import { chatGroq } from '../../services/groq.js';
import logger from '../../helpers/logger.js';

export const postChat = async (req, res) => {
  try {
    const { message, history = [], model, context = 'general' } = req.body;
    if (!message) return error(res, 'Message is required', 400);

    const start = Date.now();
    logger.info(`CHAT REQ | model=${model || 'default'} | context=${context} | msg="${message.slice(0, 60)}..."`);

    const result = await chat(message, history, model, context);

    logger.info(`CHAT RES | ${Date.now() - start}ms | reply="${result.reply?.slice(0, 60)}..."`);
    success(res, result);
  } catch (err) {
    logger.error('Chat failed', err.message);
    error(res, err.message);
  }
};

export const postGroqChat = async (req, res) => {
  try {
    const { message, history = [], model = 'llama-3.3-70b', system, maxTokens, temperature } = req.body;
    if (!message) return error(res, 'Message is required', 400);

    const start = Date.now();
    logger.info(`GROQ REQ | model=${model} | msg="${message.slice(0, 60)}..."`);

    const result = await chatGroq(message, history, model, { system, maxTokens, temperature });

    logger.info(`GROQ RES | ${Date.now() - start}ms | model=${result.model} | tokens=${result.tokens}`);
    success(res, result);
  } catch (err) {
    logger.error('Groq chat failed', err.message);
    // Pass rate limit info if 429
    const status = err.message.includes('429') ? 429 : 500;
    error(res, err.message, status);
  }
};

export const postAI = async (req, res) => {
  try {
    const { messages, model, system, maxTokens, temperature } = req.body;
    if (!messages?.length) return error(res, 'Messages array is required', 400);

    const start = Date.now();
    const result = await rawQuery(messages, model, { system, maxTokens, temperature });

    logger.info(`AI RES | ${Date.now() - start}ms | model=${result.model} | tokens=${result.tokens}`);
    success(res, result);
  } catch (err) {
    logger.error('AI query failed', err.message);
    error(res, err.message);
  }
};
