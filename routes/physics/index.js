// /physics/* — Server-side heavy compute for the FE Physics Lab page.
//
// Public routes, no auth. All handlers are POST — bodies carry the
// pendulum params, initial state, and integration knobs. See the
// controller for validation rules (duration <= 60s, dt >= 0.001s).

import { Router } from 'express';
import {
  postSimulate,
  postPhase,
  postLyapunov,
} from '../../controllers/physics/index.js';

const router = Router();

router.post('/physics/pendulum/simulate', postSimulate);
router.post('/physics/pendulum/phase',    postPhase);
router.post('/physics/pendulum/lyapunov', postLyapunov);

export default router;
