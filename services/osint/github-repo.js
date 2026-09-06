// GitHub public repo. Uses the same anonymous quota as github-user.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'github-repo',
  description: 'GitHub public repo metadata (stars, forks, topics). Keyless.',
  paramSchema: [
    { key: 'owner', label: 'Owner', type: 'text', placeholder: 'facebook', helper: 'GitHub org or user', required: true, source: 'path' },
    { key: 'repo',  label: 'Repo',  type: 'text', placeholder: 'react',    helper: 'Repository name',   required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ owner, repo }) {
    const o = required(owner, 'owner');
    const r = required(repo, 'repo');
    return cached(`gh-repo:${o.toLowerCase()}/${r.toLowerCase()}`, 10 * 60 * 1000, () =>
      fetchJson(`https://api.github.com/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`));
  },
};
