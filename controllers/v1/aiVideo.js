import { success, error } from '../../helpers/res_helper.js';
import { generateVideo, VIDEO_PROVIDERS, VIDEO_MODELS_BY_PROVIDER } from '../../services/aiVideo/index.js';
import { generateGroqCaption } from '../../services/aiVideo/caption.js';
import { saveVideoBuffer, saveVideoMetadata, getLatestVideo, getRecentVideos, newVideoId } from '../../services/aiVideo/storage.js';
import logger from '../../helpers/logger.js';

const ALIASES = { worker: 'comfyui', gpu: 'comfyui', huggingface: 'hf' };

export const postGenerateVideo = async (req, res) => {
  try {
    const {
      prompt,
      provider: rawProvider = 'auto',
      model,
      duration = 5,
      resolution = '1080p',
      aspectRatio = '9:16',
      style = 'cinematic',
      audio = true,
      imageUrl = '',
      generateCaption = true,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return error(res, 'Prompt is required', 400);
    }

    const p = ALIASES[rawProvider.toLowerCase()] || rawProvider.toLowerCase();
    if (!VIDEO_PROVIDERS.includes(p)) {
      return error(res, `Invalid provider. Use one of: ${VIDEO_PROVIDERS.join(', ')}`, 400);
    }

    const cleanPrompt = prompt.trim();
    const styleAlreadyIn = style && cleanPrompt.toLowerCase().includes(style.toLowerCase());
    const styled = (style && !styleAlreadyIn && p !== 'zsky')
      ? `${cleanPrompt}, ${style}`
      : cleanPrompt;
    const start = Date.now();
    logger.info(`AI VIDEO REQ | provider=${p} | model=${model || 'default'} | "${cleanPrompt.slice(0, 60)}"`);

    const [result, caption] = await Promise.all([
      generateVideo(styled, { provider: p, model, duration, resolution, aspectRatio, audio, style, imageUrl }),
      generateCaption ? generateGroqCaption(prompt.trim()).catch(() => null) : Promise.resolve(null),
    ]);

    const videoId = newVideoId();
    let videoUrl = result.videoUrl;
    let storage = 'remote';

    if (!videoUrl && result.buffer) {
      const saved = await saveVideoBuffer(result.buffer, videoId);
      videoUrl = saved.publicPath;
      storage = 'local';
    }
    if (!videoUrl) throw new Error('Provider returned neither a videoUrl nor a buffer');

    const record = {
      videoId,
      provider: result.providerUsed || result.provider || p,
      requestedProvider: p,
      prompt: prompt.trim(),
      videoUrl,
      caption,
      model: result.model || model,
      duration,
      resolution,
      aspectRatio,
      style,
      audio,
      imageUrl: imageUrl || '',
      storage,
      createdAt: new Date().toISOString(),
    };
    await saveVideoMetadata(record);

    logger.info(`AI VIDEO RES | ${Date.now() - start}ms | ${videoId} | used=${record.provider} | ${storage}`);
    return success(res, { success: true, ...record });
  } catch (err) {
    logger.error('AI video gen failed', err.message);
    let msg = err.message || 'Generation failed';
    if (/produced no output|rejected the workflow|empty results/i.test(msg)) {
      msg = `ZSky's GPU worker glitched on this render (auto-retried once, still failed). This is on their side, not your prompt — try again in 30 seconds, the next worker usually picks it up cleanly.`;
    }
    const status = err.contentPolicy ? 400
      : msg.includes('loading') ? 503
      : msg.includes('limit') || msg.includes('rate') ? 429
      : msg.includes('not configured') || msg.includes('not reachable') ? 503
      : msg.includes('GPU worker glitched') ? 502
      : 500;
    return error(res, msg, status);
  }
};

export const getTodayVideo = async (_req, res) => {
  try {
    const latest = await getLatestVideo();
    return success(res, latest || null);
  } catch (err) {
    return error(res, err.message);
  }
};

export const getVideoList = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
    const items = await getRecentVideos(limit);
    return success(res, items);
  } catch (err) {
    return error(res, err.message);
  }
};

export const getVideoProviders = (_req, res) => {
  return success(res, {
    providers: VIDEO_PROVIDERS,
    models: VIDEO_MODELS_BY_PROVIDER,
    fallbackOrder: ['zsky', 'hf', 'comfyui'],
  });
};
