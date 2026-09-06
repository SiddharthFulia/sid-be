// scripts/test-osint-tools.mjs — smoke-test every registered OSINT tool
// against a sample payload. Usage: `node scripts/test-osint-tools.mjs`.
//
// Reports pass/fail per tool and exits non-zero if anything unexpected broke.
// Tools whose upstream requires a key we don't have are expected to throw a
// 501 — that's counted as `skipped`, not `failed`.

import 'dotenv/config';
import { tools, manifest } from '../services/osint/index.js';

// Sample fixtures per tool. Each entry defines pathParams (positional) and
// query params. Missing = tool takes no params.
const FIXTURES = {
  ipwho        : { path: { ip: '8.8.8.8' } },
  'ipapi-lite' : { path: { ip: '8.8.8.8' } },
  ipify        : {},
  bgpview      : { path: { asn: '15169' } },
  peeringdb    : { path: { asn: '15169' } },
  rdap         : { path: { domain: 'example.com' } },
  mxrecords    : { path: { domain: 'google.com' } },
  dnslytics    : { path: { ip: '8.8.8.8' } },
  phone        : { path: { num: '+14155552671' } },
  genderize    : { path: { name: 'sarah' } },
  agify        : { path: { name: 'sarah' } },
  nationalize  : { path: { name: 'sarah' } },
  binlist      : { path: { bin: '45717360' } },
  coingecko    : { path: { coinId: 'bitcoin' } },
  exchangerate : { path: { base: 'USD', target: 'EUR' } },
  fdic         : { query: { state: 'CALIFORNIA', limit: 5 } },
  wikipedia    : { path: { query: 'Node.js' } },
  wikidata     : { path: { query: 'Node.js' } },
  openlibrary  : { path: { isbn: '9780134685991' } },
  urban        : { path: { term: 'api' } },
  'nasa-neo'   : { path: { date: '2024-10-01' } },
  openaq       : { path: { city: 'delhi' } },
  waqi         : { path: { city: 'delhi' } },
  randomuser   : { query: { results: 1 } },
  picsum       : { query: { page: 1, limit: 5 } },
  joke         : {},
  'github-user': { path: { user: 'octocat' } },
  'github-repo': { path: { owner: 'facebook', repo: 'react' } },
  nominatim    : { path: { query: 'Eiffel Tower' }, query: { limit: 3 } },
  'open-meteo' : { path: { lat: '48.85', lng: '2.35' } },
  urlscan      : { path: { query: 'domain:google.com' } },
  otx          : { path: { indicator: '8.8.8.8' } },
};

const RESULTS = [];
const names = Object.keys(tools);

console.log(`Testing ${names.length} OSINT tools…\n`);

for (const name of names) {
  const tool = tools[name];
  const fx = FIXTURES[name] || {};
  const start = Date.now();
  let status = 'pass';
  let note = '';
  try {
    const data = await tool.run(fx.path || {}, fx.query || {});
    // Sanity: expect a non-null response.
    if (data == null) { status = 'fail'; note = 'null response'; }
    else {
      const size = JSON.stringify(data).length;
      note = `${size}B`;
    }
  } catch (e) {
    if (e.status === 501) {
      status = 'skipped';
      note = `501 · ${tool.needsKey || 'no-key'} missing`;
    } else {
      status = 'fail';
      note = `${e.status || '?'} · ${(e.message || 'error').slice(0, 60)}`;
    }
  }
  const ms = Date.now() - start;
  RESULTS.push({ name, status, ms, note });
  const icon = status === 'pass' ? '[PASS]' : status === 'skipped' ? '[SKIP]' : '[FAIL]';
  console.log(`${icon} ${name.padEnd(16)} ${String(ms).padStart(5)}ms  ${note}`);
}

const passed  = RESULTS.filter(r => r.status === 'pass').length;
const skipped = RESULTS.filter(r => r.status === 'skipped').length;
const failed  = RESULTS.filter(r => r.status === 'fail').length;

console.log(`\nPass ${passed} · Skip ${skipped} · Fail ${failed}`);

// Emit a machine-readable summary as the last line so CI can grep for it.
console.log(`SUMMARY ${JSON.stringify({ passed, skipped, failed, results: RESULTS })}`);

// Fail the process if any tool broke unexpectedly. Skipped (missing key) is fine.
process.exit(failed > 0 ? 1 : 0);
