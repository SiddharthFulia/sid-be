// FDIC BankFind — US banks database. Free, keyless.
import { fetchJson, cached } from './_common.js';

export default {
  name: 'fdic',
  description: 'FDIC BankFind search (US banks by name / state). Keyless.',
  paramSchema: [
    { key: 'state', label: 'State', type: 'text', placeholder: 'CALIFORNIA', helper: 'Full state name (uppercase), optional', required: false, source: 'query' },
    { key: 'name',  label: 'Name',  type: 'text', placeholder: 'Chase',      helper: 'Bank name fragment, optional',            required: false, source: 'query' },
    { key: 'limit', label: 'Limit', type: 'number', placeholder: '10',       helper: 'Max results (1–50)',                     required: false, source: 'query' },
  ],
  needsKey: null,
  async run(_p, { state, name, limit } = {}) {
    const filters = [];
    if (state) filters.push(`STNAME:"${String(state).toUpperCase().replace(/"/g, '')}"`);
    if (name)  filters.push(`NAME:*${String(name).replace(/[^\w\s\-]/g, '')}*`);
    const params = new URLSearchParams();
    if (filters.length) params.set('filters', filters.join(' AND '));
    params.set('limit', String(Math.max(1, Math.min(50, parseInt(limit, 10) || 10))));
    return cached(`fdic:${params.toString()}`, 60 * 60 * 1000, () =>
      fetchJson(`https://banks.data.fdic.gov/api/institutions?${params.toString()}`));
  },
};
