// urlscan.io — free tier requires an API key. 501 gracefully if missing.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'urlscan',
  description: 'urlscan.io search index (submitted URL scans). Requires URLSCAN_KEY.',
  paramSchema: [
    { key: 'query', label: 'Query', type: 'text', placeholder: 'domain:google.com', helper: 'Lucene query (domain:x, ip:x, filename:x)', required: true, source: 'path' },
    { key: 'size',  label: 'Size',  type: 'number', placeholder: '5', helper: 'Max results (1–100)', required: false, source: 'query' },
  ],
  needsKey: 'URLSCAN_KEY',
  async run({ query }, { size } = {}) {
    const q = required(query, 'query');
    const key = process.env.URLSCAN_KEY;
    if (!key) {
      const e = new Error('URLSCAN_KEY not configured');
      e.status = 501;
      throw e;
    }
    const sz = Math.max(1, Math.min(100, parseInt(size, 10) || 5));
    return cached(`urlscan:${q}:${sz}`, 5 * 60 * 1000, () =>
      fetchJson(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(q)}&size=${sz}`, {
        headers: { 'API-Key': key },
      }));
  },
};
