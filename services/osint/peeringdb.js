// PeeringDB — free ASN → network info (name, org, policy, contacts).
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'peeringdb',
  description: 'PeeringDB network info for an ASN. Keyless.',
  paramSchema: [
    { key: 'asn', label: 'ASN', type: 'text', placeholder: '15169', helper: 'Autonomous system number', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ asn }) {
    const q = required(asn, 'asn').replace(/^AS/i, '');
    if (!/^\d+$/.test(q)) {
      const e = new Error('asn must be numeric');
      e.status = 400;
      throw e;
    }
    return cached(`peeringdb:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://www.peeringdb.com/api/net?asn=${q}`));
  },
};
