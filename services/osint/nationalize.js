// Nationalize.io — first-name → predicted nationality. Keyless.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'nationalize',
  description: 'Predict nationality from a first name. Keyless.',
  paramSchema: [
    { key: 'name', label: 'First name', type: 'text', placeholder: 'sarah', helper: 'A single first name', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ name }) {
    const q = required(name, 'name').toLowerCase();
    return cached(`nationalize:${q}`, 60 * 60 * 1000, () =>
      fetchJson(`https://api.nationalize.io/?name=${encodeURIComponent(q)}`));
  },
};
