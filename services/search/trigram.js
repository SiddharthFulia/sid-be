// Trigram helpers — used by the city-graphs /places fuzzy search.
//
// Why trigrams? Prefix (Trie) is fast but brittle — "dar" won't surface
// "Dadar" without a substring pass, and typos slide right past a prefix
// hit. A tiny bag-of-3grams index gives us cheap Jaccard-ish overlap
// scoring that catches mid-word matches and small misspellings without
// the cost of a proper edit-distance table.
//
// All work is lowercase, punctuation-stripped, and split on whitespace
// before the 3gram window slides. Very short tokens (< 3 chars) are
// kept as one 3gram padded with spaces so single-word "goa" still
// indexes and scores.

// tokenize('Malabar Hill, Mumbai!') → ['malabar', 'hill', 'mumbai']
export function tokenize(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// trigrams('dadar') → Set { 'dad', 'ada', 'dar' }
// trigrams('goa')   → Set { 'goa' } (padded — kept short so cross-set
// overlaps still fire for short tokens like 'goa' or 'iit').
export function trigrams(token) {
  const t = String(token || '').toLowerCase();
  const out = new Set();
  if (!t) return out;
  if (t.length < 3) {
    out.add(t.padEnd(3, ' '));
    return out;
  }
  for (let i = 0; i + 3 <= t.length; i++) {
    out.add(t.slice(i, i + 3));
  }
  return out;
}

// Sørensen-Dice-style overlap: 2 * |A ∩ B| / (|A| + |B|). 1.0 = identical
// bag, 0 = no shared trigrams. Cheap Set-iteration — smaller set drives
// the loop.
export function overlap(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let hits = 0;
  for (const g of small) if (big.has(g)) hits++;
  return (2 * hits) / (a.size + b.size);
}

// Convenience: build the trigram bag for a whole phrase by unioning its
// per-token 3grams. Keeps multi-word landmarks ("Cubbon Park") comparable
// against a single-token query.
export function phraseTrigrams(s) {
  const out = new Set();
  for (const tok of tokenize(s)) {
    for (const g of trigrams(tok)) out.add(g);
  }
  return out;
}
