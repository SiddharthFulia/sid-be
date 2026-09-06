// /osint/* — Free-tier OSINT proxy routes.
//
// All handlers live in controllers/osint/index.js. Every route is GET, public,
// and cached in-memory. Individual routes gracefully 501 with
// `{ error: 'auth-not-configured' }` when their upstream API key is missing.

import { Router } from 'express';
import {
  getEarthquakes,
  getEonet,
  getWeatherAlerts,
  getIss,
  getAstros,
  getSatellites,
  getFlights,
  getIp,
  getDomain,
  getWhois,
  getName,
  getBreach,
  getCve,
  getCryptoBtc,
  getCryptoEth,
  getQuotes,
  getCountries,
  getExchange,
  getDns,
  getHackernews,
} from '../../controllers/osint/index.js';

const router = Router();

// Geo / environment
router.get('/osint/earthquakes',    getEarthquakes);
router.get('/osint/eonet',          getEonet);
router.get('/osint/weather-alerts', getWeatherAlerts);

// Space
router.get('/osint/iss',        getIss);
router.get('/osint/astros',     getAstros);
router.get('/osint/satellites', getSatellites);
router.get('/osint/flights',    getFlights);

// Network / identity
router.get('/osint/ip/:ip',         getIp);
router.get('/osint/domain/:domain', getDomain);
router.get('/osint/whois/:domain',  getWhois);
router.get('/osint/dns/:domain',    getDns);
router.get('/osint/name/:name',     getName);
router.get('/osint/breach/:email',  getBreach);

// Security / crypto
router.get('/osint/cve/:cveId',           getCve);
router.get('/osint/crypto/btc/:address',  getCryptoBtc);
router.get('/osint/crypto/eth/:address',  getCryptoEth);

// Reference / market
router.get('/osint/quotes',         getQuotes);
router.get('/osint/countries',      getCountries);
router.get('/osint/exchange/:base', getExchange);

// News
router.get('/osint/hackernews/:type', getHackernews);

export default router;
