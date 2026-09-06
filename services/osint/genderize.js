// Genderize.io — first-name → predicted gender + probability. Keyless.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'genderize',
  description: 'Predict gender from a first name. Keyless.',
  paramSchema: [
    { key: 'name', label: 'First name', type: 'text', placeholder: 'sarah', helper: 'A single first name', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ name }) {
    const q = required(name, 'name').toLowerCase();
    return cached(`genderize:${q}`, 60 * 60 * 1000, () =>
      fetchJson(`https://api.genderize.io/?name=${encodeURIComponent(q)}`));
  },
};
