// Card BIN lookup — we intended binlist.net but its endpoint blocks our server.
// HandyAPI's data.handyapi.com/bin/:bin is the free, keyless replacement.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'binlist',
  description: 'Card BIN → scheme, type, country, issuer bank (via HandyAPI).',
  paramSchema: [
    { key: 'bin', label: 'BIN', type: 'text', placeholder: '45717360', helper: 'First 6-8 digits of a payment card', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ bin }) {
    const q = required(bin, 'bin');
    if (!/^\d{6,8}$/.test(q)) {
      const e = new Error('bin must be 6-8 digits');
      e.status = 400;
      throw e;
    }
    return cached(`binlist:${q}`, 24 * 60 * 60 * 1000, () =>
      fetchJson(`https://data.handyapi.com/bin/${q}`));
  },
};
