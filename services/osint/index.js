// services/osint/index.js — registry of every OSINT tool.
//
// Each tool file exports a default object with { name, description,
// paramSchema, needsKey, run }. This module aggregates them into a `tools`
// map + a serialisable `manifest` array the FE fetches at /api/osint/tools.
//
// Adding a new tool:
//   1. Drop a file under services/osint/<slug>.js
//   2. Add one import + one map entry below
//   3. Optionally add a REST alias in controllers/osint/index.js if it deserves
//      a friendly URL (otherwise the generic /tools/:name dispatcher handles it)

import ipwho       from './ipwho.js';
import ipapiLite   from './ipapi-lite.js';
import ipify       from './ipify.js';
import bgpview     from './bgpview.js';
import peeringdb   from './peeringdb.js';
import rdap        from './rdap.js';
import mxrecords   from './mxrecords.js';
import dnslytics   from './dnslytics.js';
import phone       from './phone.js';
import genderize   from './genderize.js';
import agify       from './agify.js';
import nationalize from './nationalize.js';
import binlist     from './binlist.js';
import coingecko   from './coingecko.js';
import exchangerate from './exchangerate.js';
import fdic        from './fdic.js';
import wikipedia   from './wikipedia.js';
import wikidata    from './wikidata.js';
import openlibrary from './openlibrary.js';
import urban       from './urban.js';
import nasaNeo     from './nasa-neo.js';
import openaq      from './openaq.js';
import waqi        from './waqi.js';
import randomuser  from './randomuser.js';
import picsum      from './picsum.js';
import joke        from './joke.js';
import githubUser  from './github-user.js';
import githubRepo  from './github-repo.js';
import nominatim   from './nominatim.js';
import openMeteo   from './open-meteo.js';
import urlscan     from './urlscan.js';
import otx         from './otx.js';

// Keyed by tool name. The key must match `tool.name` — enforced at load below.
export const tools = {
  ipwho, 'ipapi-lite': ipapiLite, ipify, bgpview, peeringdb, rdap, mxrecords,
  dnslytics, phone, genderize, agify, nationalize, binlist, coingecko,
  exchangerate, fdic, wikipedia, wikidata, openlibrary, urban,
  'nasa-neo': nasaNeo, openaq, waqi, randomuser, picsum, joke,
  'github-user': githubUser, 'github-repo': githubRepo, nominatim,
  'open-meteo': openMeteo, urlscan, otx,
};

// Sanity check — each tool's exported `name` must match its map key.
for (const [key, tool] of Object.entries(tools)) {
  if (!tool || tool.name !== key) {
    throw new Error(`OSINT tool registry mismatch: key=${key} tool.name=${tool?.name}`);
  }
}

// Manifest — the shape the FE consumes to auto-render every tool card.
export function manifest() {
  return Object.values(tools).map((t) => ({
    name: t.name,
    description: t.description,
    paramSchema: t.paramSchema || [],
    needsKey: t.needsKey || null,
    // `configured` tells the FE whether an auth-required tool actually has its
    // key set on this server — used to badge tools green ✓ or grey ✗ up-front
    // so users don't smash "Run" only to see a 501.
    configured: t.needsKey ? !!process.env[t.needsKey] : true,
  }));
}
