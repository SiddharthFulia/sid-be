// CoinGecko free tier — no key required, generous rate limit for casual use.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'coingecko',
  description: 'Cryptocurrency coin info (price, marketcap, links). Keyless.',
  paramSchema: [
    { key: 'coinId', label: 'Coin ID', type: 'text', placeholder: 'bitcoin', helper: 'CoinGecko coin slug (e.g. bitcoin, ethereum, solana)', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ coinId }) {
    const q = required(coinId, 'coinId').toLowerCase();
    return cached(`cg:${q}`, 5 * 60 * 1000, () =>
      fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(q)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`));
  },
};
