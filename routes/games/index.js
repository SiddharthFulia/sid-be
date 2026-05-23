// /games/* — Hand Runner player registry + leaderboard.

import { Router } from 'express';
import { getPlayers, postPlayer, getPlayer, postScore, getScores } from '../../controllers/games/index.js';

const router = Router();

router.get( '/games/players',           getPlayers);
router.post('/games/players',           postPlayer);
router.get( '/games/players/:idOrName', getPlayer);
router.post('/games/scores',            postScore);
router.get( '/games/scores',            getScores);

export default router;
