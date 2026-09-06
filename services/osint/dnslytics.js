// DNSlytics free IP→ASN. Great cheap ASN lookup with no key.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'dnslytics',
  description: 'IP → ASN lookup via DNSlytics free tier. Keyless.',
  paramSchema: [
    { key: 'ip', label: 'IP address', type: 'text', placeholder: '8.8.8.8', helper: 'IPv4 address', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ ip }) {
    const q = required(ip, 'ip');
    return cached(`dnslytics:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://freeapi.dnslytics.net/v1/ip2asn/${encodeURIComponent(q)}`));
  },
};
