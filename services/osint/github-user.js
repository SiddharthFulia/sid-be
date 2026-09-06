// GitHub public user profile. Unauthenticated tier = 60 req/hr per IP.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'github-user',
  description: 'GitHub public user profile (repos, followers, bio). Keyless.',
  paramSchema: [
    { key: 'user', label: 'Username', type: 'text', placeholder: 'octocat', helper: 'GitHub username', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ user }) {
    const q = required(user, 'user');
    return cached(`gh-user:${q.toLowerCase()}`, 10 * 60 * 1000, () =>
      fetchJson(`https://api.github.com/users/${encodeURIComponent(q)}`));
  },
};
