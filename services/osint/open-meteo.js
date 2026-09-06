// Open-Meteo — fully free weather forecast API, keyless.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'open-meteo',
  description: 'Current + hourly weather forecast for lat/lng. Keyless.',
  paramSchema: [
    { key: 'lat', label: 'Latitude',  type: 'number', placeholder: '48.85', helper: 'Latitude in decimal degrees',  required: true, source: 'path' },
    { key: 'lng', label: 'Longitude', type: 'number', placeholder: '2.35',  helper: 'Longitude in decimal degrees', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ lat, lng }) {
    const la = parseFloat(required(lat, 'lat'));
    const lo = parseFloat(required(lng, 'lng'));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      const e = new Error('lat/lng must be finite numbers');
      e.status = 400;
      throw e;
    }
    return cached(`meteo:${la.toFixed(3)}:${lo.toFixed(3)}`, 5 * 60 * 1000, () =>
      fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=3`));
  },
};
