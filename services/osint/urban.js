// Urban Dictionary — slang definitions. Keyless.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'urban',
  description: 'Urban Dictionary slang definitions. Keyless.',
  paramSchema: [
    { key: 'term', label: 'Term', type: 'text', placeholder: 'api', helper: 'Word or phrase', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ term }) {
    const q = required(term, 'term');
    return cached(`urban:${q.toLowerCase()}`, 60 * 60 * 1000, () =>
      fetchJson(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(q)}`));
  },
};
