// randomuser.me — synthetic user generator. Keyless.
import { fetchJson } from './_common.js';

export default {
  name: 'randomuser',
  description: 'Generate a random synthetic user profile. Keyless.',
  paramSchema: [
    { key: 'results', label: 'Count',    type: 'number', placeholder: '1',  helper: 'Number of users (1–20)', required: false, source: 'query' },
    { key: 'nat',     label: 'Nation',   type: 'text',   placeholder: 'us', helper: '2-letter country hint (us, gb, in…)', required: false, source: 'query' },
    { key: 'gender',  label: 'Gender',   type: 'text',   placeholder: '',   helper: 'male, female, or blank', required: false, source: 'query' },
  ],
  needsKey: null,
  async run(_p, { results, nat, gender } = {}) {
    const p = new URLSearchParams();
    p.set('results', String(Math.max(1, Math.min(20, parseInt(results, 10) || 1))));
    if (nat)    p.set('nat', String(nat).toLowerCase().slice(0, 2));
    if (gender) p.set('gender', String(gender).toLowerCase());
    // No caching — random.
    return fetchJson(`https://randomuser.me/api/?${p.toString()}`);
  },
};
