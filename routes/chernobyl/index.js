// /api/chernobyl/* — RBMK-1000 reactor simulator routes.
//
// Public, no auth. All handlers wrap the pure math in
// services/physics/reactor.js — see controllers/chernobyl/index.js for
// validation limits (duration ≤ 300 s, dt ≥ 0.001 s).
//
//   POST /api/chernobyl/simulate        — arbitrary scenario / custom controls
//   POST /api/chernobyl/scenario/az5    — 1986 Chernobyl preset, no body needed
//   GET  /api/chernobyl/scenarios       — list preset scenarios + descriptions

import { Router } from 'express';
import {
  postSimulate,
  postAz5,
  getScenarios,
} from '../../controllers/chernobyl/index.js';

const router = Router();

router.post('/chernobyl/simulate',     postSimulate);
router.post('/chernobyl/scenario/az5', postAz5);
router.get ('/chernobyl/scenarios',    getScenarios);

export default router;
