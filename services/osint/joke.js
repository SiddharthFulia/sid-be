// icanhazdadjoke — clean, keyless joke API. Accept: application/json required.
import { fetchJson } from './_common.js';

export default {
  name: 'joke',
  description: 'Random dad joke (icanhazdadjoke). Keyless.',
  paramSchema: [],
  needsKey: null,
  async run() {
    // No caching — random.
    return fetchJson('https://icanhazdadjoke.com/');
  },
};
