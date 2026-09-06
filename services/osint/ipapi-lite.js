// ipapi.co — 1000 free requests/day, no key needed for the /json endpoint.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'ipapi-lite',
  description: 'ipapi.co lite geolocation. 1000/day free, no key.',
  paramSchema: [
    { key: 'ip', label: 'IP address', type: 'text', placeholder: '8.8.8.8', helper: 'IPv4 or IPv6 address', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ ip }) {
    const q = required(ip, 'ip');
    return cached(`ipapi-lite:${q}`, 5 * 60 * 1000, () =>
      fetchJson(`https://ipapi.co/${encodeURIComponent(q)}/json/`));
  },
};
