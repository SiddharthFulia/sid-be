import { success, error } from '../../helpers/res_helper.js';
import { proxyNasa } from '../../services/nasa.js';
import logger from '../../helpers/logger.js';

/**
 * NASA API Proxy — hides API key from frontend.
 *
 * Frontend calls:  GET /api/nasa/planetary/apod?date=2024-01-01
 * Backend proxies: https://api.nasa.gov/planetary/apod?date=2024-01-01&api_key=XXX
 *
 * Also handles third-party APIs that have CORS issues:
 *   GET /api/nasa/proxy/fireball    → ssd-api.jpl.nasa.gov/fireball.api
 *   GET /api/nasa/proxy/iss         → api.open-notify.org/iss-now.json
 *   GET /api/nasa/proxy/astros      → api.open-notify.org/astros.json
 *   GET /api/nasa/proxy/tle?search= → tle.ivanstanojevic.me/api/tle/
 *   GET /api/nasa/proxy/eonet       → eonet.gsfc.nasa.gov/api/v3/events
 *   GET /api/nasa/proxy/images      → images-api.nasa.gov/search
 */
export const getNasa = async (req, res) => {
  try {
    // Express 5 wildcard params come as arrays
    const raw = req.params.endpoint;
    const endpoint = Array.isArray(raw) ? raw.join('/') : raw;
    const query = req.query;

    const start = Date.now();
    const data = await proxyNasa(endpoint, query);

    logger.info(`NASA PROXY | ${Date.now() - start}ms | ${endpoint}`);

    // Send raw JSON (not wrapped) so FE can use it directly
    res.json(data);
  } catch (err) {
    logger.error(`NASA PROXY FAIL | ${req.params.endpoint}`, err.message);
    // Pass through 429 status so FE can show countdown
    const status = err.message.includes('429') ? 429 : 500;
    error(res, err.message, status);
  }
};
