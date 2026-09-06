// MX records via Cloudflare DoH. Complements the existing /dns/:domain A-record tool.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'mxrecords',
  description: 'MX (mail server) records for a domain. Cloudflare DoH, keyless.',
  paramSchema: [
    { key: 'domain', label: 'Domain', type: 'text', placeholder: 'google.com', helper: 'Bare domain', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ domain }) {
    const q = required(domain, 'domain').toLowerCase();
    return cached(`mx:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(q)}&type=MX`, {
        headers: { Accept: 'application/dns-json' },
      }));
  },
};
