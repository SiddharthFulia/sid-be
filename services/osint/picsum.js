// Lorem Picsum — placeholder image metadata list. Keyless.
import { fetchJson, cached } from './_common.js';

export default {
  name: 'picsum',
  description: 'Lorem Picsum image list (URLs + authors). Keyless.',
  paramSchema: [
    { key: 'page',  label: 'Page',  type: 'number', placeholder: '1',  helper: 'Page number (1-based)', required: false, source: 'query' },
    { key: 'limit', label: 'Limit', type: 'number', placeholder: '10', helper: 'Images per page (1–30)', required: false, source: 'query' },
  ],
  needsKey: null,
  async run(_p, { page, limit } = {}) {
    const pg = Math.max(1, parseInt(page, 10) || 1);
    const lm = Math.max(1, Math.min(30, parseInt(limit, 10) || 10));
    return cached(`picsum:${pg}:${lm}`, 60 * 60 * 1000, () =>
      fetchJson(`https://picsum.photos/v2/list?page=${pg}&limit=${lm}`));
  },
};
