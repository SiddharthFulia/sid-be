// OpenAQ v3 — air quality measurements. Needs OPENAQ_KEY. 501 if missing.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'openaq',
  description: 'Air-quality measurements from OpenAQ v3. Requires OPENAQ_KEY.',
  paramSchema: [
    { key: 'city', label: 'City', type: 'text', placeholder: 'Delhi', helper: 'City name for location match', required: true, source: 'path' },
  ],
  needsKey: 'OPENAQ_KEY',
  async run({ city }) {
    const q = required(city, 'city');
    const key = process.env.OPENAQ_KEY;
    if (!key) {
      const e = new Error('OPENAQ_KEY not configured');
      e.status = 501;
      throw e;
    }
    return cached(`openaq:${q.toLowerCase()}`, 5 * 60 * 1000, () =>
      fetchJson(`https://api.openaq.org/v3/locations?limit=25&city=${encodeURIComponent(q)}`, {
        headers: { 'X-API-Key': key },
      }));
  },
};
