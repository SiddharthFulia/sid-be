// NASA NEO (Near-Earth Objects) feed for a single date. Uses NASA_API_KEY;
// falls back to DEMO_KEY if unset so the tool still returns data (rate-limited).
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'nasa-neo',
  description: 'NASA NEO close-approach data for a date. Free NASA key.',
  paramSchema: [
    { key: 'date', label: 'Date', type: 'text', placeholder: '2024-10-01', helper: 'ISO date YYYY-MM-DD', required: true, source: 'path' },
  ],
  needsKey: null, // uses NASA_API_KEY but falls back to DEMO_KEY
  async run({ date }) {
    const d = required(date, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const e = new Error('date must be YYYY-MM-DD');
      e.status = 400;
      throw e;
    }
    const key = process.env.NASA_API_KEY || 'DEMO_KEY';
    return cached(`neo:${d}`, 60 * 60 * 1000, () =>
      fetchJson(`https://api.nasa.gov/neo/rest/v1/feed?start_date=${d}&end_date=${d}&api_key=${key}`));
  },
};
