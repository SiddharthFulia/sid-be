// Phone validate — parses + validates internationally without an API key by
// leaning on a simple regex + country-code heuristic. If libphonenumber-js is
// installed we use its richer parse; otherwise we fall back gracefully.
import { required } from './_common.js';

async function loadLpn() {
  try {
    const m = await import('libphonenumber-js');
    return m;
  } catch {
    return null;
  }
}

export default {
  name: 'phone',
  description: 'Parse + validate international phone numbers. No key needed.',
  paramSchema: [
    { key: 'num', label: 'Phone number', type: 'text', placeholder: '+14155552671', helper: 'E.164 format preferred (leading +)', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ num }) {
    const q = required(num, 'num');
    const lpn = await loadLpn();
    if (lpn) {
      try {
        const parsed = lpn.parsePhoneNumber(q);
        return {
          input: q,
          valid: parsed?.isValid?.() ?? false,
          possible: parsed?.isPossible?.() ?? false,
          country: parsed?.country ?? null,
          countryCallingCode: parsed?.countryCallingCode ?? null,
          nationalNumber: parsed?.nationalNumber ?? null,
          number: parsed?.number ?? null,
          type: parsed?.getType?.() ?? null,
          formatE164: parsed?.format?.('E.164') ?? null,
          formatIntl: parsed?.formatInternational?.() ?? null,
          formatNational: parsed?.formatNational?.() ?? null,
          uri: parsed?.getURI?.() ?? null,
        };
      } catch (e) {
        return { input: q, valid: false, error: e.message };
      }
    }
    // Fallback if the lib isn't installed — just check E.164 shape.
    const m = q.match(/^\+(\d{1,3})(\d{4,14})$/);
    return {
      input: q,
      valid: !!m,
      possible: !!m,
      country: null,
      countryCallingCode: m ? m[1] : null,
      nationalNumber: m ? m[2] : null,
      _fallback: 'libphonenumber-js not installed — install for country + type detection',
    };
  },
};
