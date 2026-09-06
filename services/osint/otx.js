// AlienVault OTX — indicator reputation. Free tier needs an OTX_KEY.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'otx',
  description: 'AlienVault OTX indicator reputation (IP/domain/URL). Requires OTX_KEY.',
  paramSchema: [
    { key: 'indicator', label: 'Indicator', type: 'text', placeholder: '8.8.8.8', helper: 'IP, domain, or URL', required: true, source: 'path' },
    { key: 'type',      label: 'Type',      type: 'text', placeholder: 'IPv4',    helper: 'IPv4 | IPv6 | domain | url (auto-detected if blank)', required: false, source: 'query' },
  ],
  needsKey: 'OTX_KEY',
  async run({ indicator }, { type } = {}) {
    const q = required(indicator, 'indicator');
    const key = process.env.OTX_KEY;
    if (!key) {
      const e = new Error('OTX_KEY not configured');
      e.status = 501;
      throw e;
    }
    // Auto-detect the OTX section from the shape of the input.
    const auto = type || (/^\d+\.\d+\.\d+\.\d+$/.test(q) ? 'IPv4' : /^https?:\/\//i.test(q) ? 'url' : 'domain');
    return cached(`otx:${auto}:${q}`, 30 * 60 * 1000, () =>
      fetchJson(`https://otx.alienvault.com/api/v1/indicators/${encodeURIComponent(auto)}/${encodeURIComponent(q)}/general`, {
        headers: { 'X-OTX-API-KEY': key },
      }));
  },
};
