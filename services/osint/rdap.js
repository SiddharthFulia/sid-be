// RDAP — modern DNS-based whois replacement. Fully public, no key.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'rdap',
  description: 'RDAP domain lookup (modern whois). Registrar, dates, DNSSEC.',
  paramSchema: [
    { key: 'domain', label: 'Domain', type: 'text', placeholder: 'example.com', helper: 'Bare domain, no scheme', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ domain }) {
    const q = required(domain, 'domain').toLowerCase();
    return cached(`rdap:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://rdap.org/domain/${encodeURIComponent(q)}`));
  },
};
