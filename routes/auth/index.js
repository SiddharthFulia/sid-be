// Vault auth — POST /auth/vault-login + GET /auth/vault-status.
// The login endpoint accepts a shared password and returns a JWT used by
// the FE on Vault-gated UIs. Status pings just verify the token is valid.

import { Router } from 'express';
import { checkVaultPassword, signVaultToken, requireVault } from '../../services/auth/vault.js';
import { success, error } from '../../helpers/res_helper.js';

const router = Router();

router.post('/auth/vault-login', (req, res) => {
  const { password } = req.body || {};
  if (!checkVaultPassword(password)) {
    return error(res, 'Invalid password', 401);
  }
  return success(res, { token: signVaultToken() });
});

router.get('/auth/vault-status', requireVault, (_req, res) => success(res, { ok: true }));

export default router;
