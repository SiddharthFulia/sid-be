// /chess/* — Stockfish engine analysis, saved games + collections,
// live online matches.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  postBestMove, postAnalyze, postPlay, getStatus,
  postSaveGame, getGames, getOneGame, patchGame, removeGame,
  postBulkSaveGames, getCollections,
  postCreateMatch, postJoinMatch, getMatchState, postMatchMove, postResignMatch,
  listLiveMatches,
} from '../../controllers/chess/index.js';

const router = Router();

// Engine analysis lane (Stockfish via node-uci)
router.post('/chess/best-move', postBestMove);
router.post('/chess/analyze',   postAnalyze);
router.post('/chess/play',      postPlay);
router.get( '/chess/status',    getStatus);

// Saved-games library
router.post(  '/chess/games',         postSaveGame);
router.get(   '/chess/games',         getGames);
router.get(   '/chess/games/:id',     getOneGame);
router.patch( '/chess/games/:id',     patchGame);
router.post(  '/chess/games/bulk',    postBulkSaveGames);
router.get(   '/chess/collections',   getCollections);
router.delete('/chess/games/:id',     requireVault, removeGame);   // §75 — vault gate

// Live online challenge matches
router.post(  '/chess/matches',             postCreateMatch);
router.post(  '/chess/matches/:id/join',    postJoinMatch);
router.get(   '/chess/matches/:id',         getMatchState);
router.post(  '/chess/matches/:id/move',    postMatchMove);
router.post(  '/chess/matches/:id/resign',  postResignMatch);
// Lobby — deeper path than /:id so Express won't route-match it under :id.
router.get(   '/chess/matches/lobby/live',  listLiveMatches);

export default router;
