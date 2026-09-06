// OSM Nominatim geocoder — free, keyless. Requires a descriptive UA.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'nominatim',
  description: 'OpenStreetMap geocoding (place → lat/lng). Keyless.',
  paramSchema: [
    { key: 'query', label: 'Place', type: 'text', placeholder: 'Eiffel Tower', helper: 'Free-form place name', required: true, source: 'path' },
    { key: 'limit', label: 'Limit', type: 'number', placeholder: '5', helper: 'Max results (1–20)', required: false, source: 'query' },
  ],
  needsKey: null,
  async run({ query }, { limit } = {}) {
    const q = required(query, 'query');
    const lm = Math.max(1, Math.min(20, parseInt(limit, 10) || 5));
    return cached(`nominatim:${q.toLowerCase()}:${lm}`, 60 * 60 * 1000, () =>
      fetchJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${lm}&addressdetails=1`));
  },
};
