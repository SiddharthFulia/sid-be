// Server-side auth for the vaulted creation lanes (AI Video, Image Studio,
// Music). Single password, single token, no user table.
//
// Flow:
//   FE → POST /api/auth/vault-login {password}
//   ← {token: '...'}                      (JWT signed with VAULT_JWT_SECRET)
//   FE stores token in localStorage
//   FE includes `Authorization: Bearer <token>` on protected requests
//   BE middleware `requireVault` validates the JWT before letting the
//   request through.
//
// Env (set on Oracle):
//   VAULT_PASSWORD     — the single shared password ("Siddharth" by default)
//   VAULT_JWT_SECRET   — random string used to sign tokens. Rotate to revoke
//                        all existing sessions. Generate with:
//                          node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

import jwt from 'jsonwebtoken';

const VAULT_PASSWORD = process.env.VAULT_PASSWORD || 'Siddharth';
// Fallback to a derived string so dev works without explicit config. In prod
// you MUST set VAULT_JWT_SECRET to something high-entropy.
const VAULT_JWT_SECRET = process.env.VAULT_JWT_SECRET
  || `dev-fallback-${VAULT_PASSWORD}-please-set-VAULT_JWT_SECRET-in-prod`;
const TOKEN_TTL = '90d';   // long-lived single-user system. To extend without
                            // re-login, hit POST /api/auth/vault-refresh while
                            // the existing token is still valid.

export function signVaultToken() {
  return jwt.sign({ scope: 'vault' }, VAULT_JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyVaultToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, VAULT_JWT_SECRET);
    if (payload?.scope !== 'vault') return null;
    return payload;
  } catch {
    return null;
  }
}

export function checkVaultPassword(input) {
  return typeof input === 'string' && input === VAULT_PASSWORD;
}

// Express middleware. Mount on the routes that should require login.
// Sets req.vault = true on success so handlers can tag created rows.
// Returns 401 with a clear message if the header is missing/bad — the FE
// VaultGate listens for that status to bounce back to the login screen.
export function requireVault(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!verifyVaultToken(token)) {
    return res.status(401).json({
      status: false,
      message: 'Vault auth required',
      code: 'VAULT_REQUIRED',
    });
  }
  req.vault = true;
  next();
}

// Soft variant — same JWT check but never blocks the request. Just sets
// req.vault = true if a valid token is present. Used on read endpoints
// (list / status) so they can return vault items to authenticated users
// AND a public subset to anonymous visitors from the same handler.
export function maybeVault(req, _res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (verifyVaultToken(token)) req.vault = true;
  next();
}
