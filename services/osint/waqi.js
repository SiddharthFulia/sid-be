// WAQI (World Air Quality Index) — accepts `demo` token for city queries. If
// WAQI_TOKEN is set we use it (higher limits); otherwise `demo` works fine.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'waqi',
  description: 'Real-time air-quality index for a city (waqi.info).',
  paramSchema: [
    { key: 'city', label: 'City', type: 'text', placeholder: 'delhi', helper: 'City slug (lowercase, no spaces)', required: true, source: 'path' },
  ],
  needsKey: null, // demo token works
  async run({ city }) {
    const q = required(city, 'city').toLowerCase();
    const token = process.env.WAQI_TOKEN || 'demo';
    return cached(`waqi:${q}`, 5 * 60 * 1000, () =>
      fetchJson(`https://api.waqi.info/feed/${encodeURIComponent(q)}/?token=${token}`));
  },
};
