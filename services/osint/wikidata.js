// Wikidata entity search — keyless.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'wikidata',
  description: 'Wikidata entity search (Q-numbers + labels). Keyless.',
  paramSchema: [
    { key: 'query', label: 'Search',   type: 'text', placeholder: 'Node.js', helper: 'Search term', required: true, source: 'path' },
    { key: 'lang',  label: 'Language', type: 'text', placeholder: 'en',      helper: '2-letter language code (default en)', required: false, source: 'query' },
  ],
  needsKey: null,
  async run({ query }, { lang } = {}) {
    const q = required(query, 'query');
    const l = String(lang || 'en').toLowerCase().slice(0, 3);
    return cached(`wikidata:${l}:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=${l}&format=json&origin=*`));
  },
};
