// BGP AS overview — we intended to use bgpview.io but its API blocks our
// server. RIPEstat's `as-overview` is the closest free-tier keyless
// equivalent and returns the same shape (holder, resource, block).
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'bgpview',
  description: 'ASN → holder, prefix block, announcement info (via RIPEstat).',
  paramSchema: [
    { key: 'asn', label: 'ASN', type: 'text', placeholder: '15169', helper: 'Autonomous system number (no "AS" prefix)', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ asn }) {
    const q = required(asn, 'asn').replace(/^AS/i, '');
    if (!/^\d+$/.test(q)) {
      const e = new Error('asn must be numeric');
      e.status = 400;
      throw e;
    }
    return cached(`bgpview:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${q}`));
  },
};
