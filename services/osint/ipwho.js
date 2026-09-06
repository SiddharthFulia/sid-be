// ipwho.is — fully free, keyless IP geolocation. No rate limit for reasonable use.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'ipwho',
  description: 'IPv4/IPv6 geolocation, ISP, timezone via ipwho.is. Keyless.',
  paramSchema: [
    { key: 'ip', label: 'IP address', type: 'text', placeholder: '8.8.8.8', helper: 'IPv4 or IPv6 address', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ ip }) {
    const q = required(ip, 'ip');
    return cached(`ipwho:${q}`, 5 * 60 * 1000, () =>
      fetchJson(`https://ipwho.is/${encodeURIComponent(q)}`));
  },
};
