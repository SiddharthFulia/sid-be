// Wikipedia REST v1 — page summary. Keyless, CORS-friendly, super fast.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'wikipedia',
  description: 'Wikipedia page summary + thumbnail. Keyless.',
  paramSchema: [
    { key: 'query', label: 'Topic', type: 'text', placeholder: 'Node.js', helper: 'Article title (spaces or underscores are fine)', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ query }) {
    const q = required(query, 'query').replace(/\s+/g, '_');
    return cached(`wiki:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`));
  },
};
