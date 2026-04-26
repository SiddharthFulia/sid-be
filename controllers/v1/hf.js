import { success, error } from '../../helpers/res_helper.js';
import { generateImage, summarizeText, textToSpeech } from '../../services/huggingface.js';
import logger from '../../helpers/logger.js';

export const postImageGen = async (req, res) => {
  try {
    const { prompt, model } = req.body;
    if (!prompt) return error(res, 'Prompt is required', 400);

    const start = Date.now();
    logger.info(`HF IMAGE REQ | prompt="${prompt.slice(0, 60)}..."`);

    const result = await generateImage(prompt, model);

    logger.info(`HF IMAGE RES | ${Date.now() - start}ms`);
    success(res, result);
  } catch (err) {
    logger.error('Image gen failed', err.message);
    error(res, err.message, err.message.includes('loading') ? 503 : 500);
  }
};

export const postTTS = async (req, res) => {
  try {
    const { text, voice, lang } = req.body;
    if (!text) return error(res, 'Text is required', 400);

    const start = Date.now();
    const result = await textToSpeech(text, voice, lang);

    logger.info(`TTS RES | ${Date.now() - start}ms`);
    success(res, result);
  } catch (err) {
    logger.error('TTS failed', err.message);
    error(res, err.message);
  }
};

export const postSummarize = async (req, res) => {
  try {
    const { text, model } = req.body;
    if (!text) return error(res, 'Text is required', 400);

    const start = Date.now();
    const result = await summarizeText(text, model);

    logger.info(`HF SUMMARIZE RES | ${Date.now() - start}ms`);
    success(res, result);
  } catch (err) {
    logger.error('Summarize failed', err.message);
    error(res, err.message);
  }
};
