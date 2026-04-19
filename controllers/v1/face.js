import { success, error } from '../../helpers/res_helper.js';
import { analyzeFace, checkHealth } from '../../services/face.js';
import logger from '../../helpers/logger.js';

export const postFaceAnalyze = async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return error(res, 'Image data is required', 400);

    const start = Date.now();
    const result = await analyzeFace(image);

    logger.info(`FACE RES | ${Date.now() - start}ms | faces=${result.faceCount}`);
    success(res, result);
  } catch (err) {
    logger.error('Face analysis failed', err.message);
    error(res, err.message);
  }
};

export const getFaceHealth = async (req, res) => {
  try {
    const healthy = await checkHealth();
    success(res, { healthy });
  } catch (err) {
    error(res, 'Face service unavailable', 503);
  }
};
