import { success, error } from '../../helpers/res_helper.js';
import { summarizeText, textToSpeech } from '../../services/huggingface.js';
import { generateImage, PROVIDERS } from '../../services/imageGen/index.js';
import { editImage } from '../../services/imageGen/imageEdit.js';
import logger from '../../helpers/logger.js';

export const postImageGen = async (req, res) => {
  try {
    const { prompt, model, provider = 'cloudflare' } = req.body;
    if (!prompt) return error(res, 'Prompt is required', 400);
    if (!PROVIDERS.includes(provider.toLowerCase())) {
      return error(res, `Invalid provider. Use one of: ${PROVIDERS.join(', ')}`, 400);
    }

    const start = Date.now();
    logger.info(`IMAGE REQ | provider=${provider} | prompt="${prompt.slice(0, 60)}..."`);

    const result = await generateImage(prompt, { provider, model });

    logger.info(`IMAGE RES | ${Date.now() - start}ms | provider=${result.provider}`);
    success(res, result);
  } catch (err) {
    logger.error('Image gen failed', err.message);
    const status = err.message.includes('loading') ? 503
      : err.message.includes('depleted') || err.message.includes('limit') ? 402
      : 500;
    error(res, err.message, status);
  }
};

export const postImageEdit = async (req, res) => {
  try {
    const { image, prompt, strength, steps } = req.body;
    if (!image) return error(res, 'Image is required', 400);
    if (!prompt) return error(res, 'Prompt is required', 400);

    const start = Date.now();
    logger.info(`IMAGE EDIT REQ | prompt="${prompt.slice(0, 60)}..." | strength=${strength}`);

    const result = await editImage(image, prompt, { strength, steps });

    logger.info(`IMAGE EDIT RES | ${Date.now() - start}ms`);
    success(res, result);
  } catch (err) {
    logger.error('Image edit failed', err.message);
    const status = err.message.includes('limit') ? 402 : 500;
    error(res, err.message, status);
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
