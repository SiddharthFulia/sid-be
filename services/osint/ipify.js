// ipify — public IP echo. Returns the caller's IP (which is the BE's server IP
// unless you go direct from FE). Kept for symmetry with the tool registry.
import { fetchJson, cached } from './_common.js';

export default {
  name: 'ipify',
  description: 'Echoes your public IP (as seen by the server). Keyless.',
  paramSchema: [],
  needsKey: null,
  async run() {
    return cached('ipify', 60 * 1000, () =>
      fetchJson('https://api.ipify.org?format=json'));
  },
};
