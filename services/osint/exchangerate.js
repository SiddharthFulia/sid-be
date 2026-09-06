// Frankfurter.app — fully free, keyless FX rates backed by the ECB.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'exchangerate',
  description: 'FX rates (Frankfurter / ECB). Keyless, daily updates.',
  paramSchema: [
    { key: 'base',   label: 'Base currency',   type: 'text', placeholder: 'USD', helper: '3-letter ISO code', required: true, source: 'path' },
    { key: 'target', label: 'Target currency', type: 'text', placeholder: 'EUR', helper: '3-letter ISO code (optional)', required: false, source: 'path' },
  ],
  needsKey: null,
  async run({ base, target }) {
    const b = required(base, 'base').toUpperCase();
    if (!/^[A-Z]{3}$/.test(b)) {
      const e = new Error('base must be a 3-letter ISO code');
      e.status = 400;
      throw e;
    }
    const t = target ? String(target).trim().toUpperCase() : '';
    const url = t
      ? `https://api.frankfurter.app/latest?from=${b}&to=${t}`
      : `https://api.frankfurter.app/latest?from=${b}`;
    return cached(`fx:${b}:${t || 'all'}`, 60 * 60 * 1000, () => fetchJson(url));
  },
};
