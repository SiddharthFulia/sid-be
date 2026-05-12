// Server-side NSFW prompt detector. Keyword/phrase regex. Imperfect (easy
// to bypass with creative spelling) but matches the user's intent of a
// simple gate: "if it looks NSFW and the user isn't logged in, reject".
// Logged-in users bypass the check entirely (they own the box).
//
// Goal here is HIGH PRECISION (avoid false positives like "sexy photo of a
// person" — that's a legit portrait prompt). Lean towards explicit anatomy,
// sex acts, undress descriptions, and strong NSFW signal words.

// One regex per category; we test all and return the first match for
// diagnostic logging.
const NSFW_PATTERNS = [
  {
    cat: 'anatomy',
    re: /\b(penis|vagina|vulva|anus|labia|clitoris|testicles?|scrotum|nipples?|areola)\b/i,
  },
  {
    cat: 'slang',
    re: /\b(tits|titties|boobs|boobies|pussy|cunt|snatch|jugs|knockers)\b/i,
  },
  {
    cat: 'sex-act',
    re: /\b(porn|pornographic|porno|erotic|erotica|orgasm|cumshot|ejaculat\w*|masturbat\w*|fellatio|cunnilingus|blowjob|handjob|deepthroat|intercourse|anal\s+sex|oral\s+sex)\b/i,
  },
  {
    cat: 'undress',
    re: /\b(naked|nude|nudity|topless|bottomless|fully\s+nude|in\s+the\s+nude|undress(?:ed|ing)?|stripping|strip(?:s|ped)?\s+naked|without\s+(?:her|his|their|any)?\s*clothes?|no\s+clothes|remove\s+(?:her|his|their|the)?\s*clothes?)\b/i,
  },
  {
    cat: 'signal',
    re: /\b(nsfw|lewd|hardcore|x-?rated|adult\s+content|adult\s+only|18\s*\+|explicit\s+(?:nudity|content)|uncensored\s+nud)\b/i,
  },
  {
    cat: 'kink',
    re: /\b(fetish|bdsm|bondage|kinky)\b/i,
  },
];

/**
 * Returns null if the prompt is clean, or { category, match } if NSFW.
 * Empty / non-string prompts pass through (caller validates separately).
 */
export function classifyPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const text = prompt.normalize('NFKC');   // catch unicode tricks
  for (const { cat, re } of NSFW_PATTERNS) {
    const m = text.match(re);
    if (m) return { category: cat, match: m[0] };
  }
  return null;
}

/** Boolean shortcut for `if (isNsfw(prompt))`. */
export function isNsfw(prompt) {
  return classifyPrompt(prompt) !== null;
}
