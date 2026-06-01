// /chess/* — Stockfish engine analysis, saved games + collections,
// live online matches.

import { Router } from 'express';
import { requireVault } from '../../services/auth/vault.js';
import {
  postBestMove, postAnalyze, postPlay, getStatus,
  postSaveGame, getGames, getOneGame, patchGame, removeGame,
  postBulkSaveGames, getCollections,
  postCreateMatch, postJoinMatch, getMatchState, postMatchMove, postResignMatch,
  postTakebackRequest, postTakebackAccept, postTakebackDecline,
  listLiveMatches,
  getOpeningsList, getOpeningDetail, getOpeningExplorer, postIdentifyOpening,
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

// ECO opening database (lichess-org/chess-openings, CC0)
// List is cheap (paginated, name + eco only); detail is lazy per-click.
// /explorer MUST sit above /:slug so the slug matcher doesn't swallow it.
router.get(   '/chess/openings',           getOpeningsList);
router.get(   '/chess/openings/explorer',  getOpeningExplorer);
// Live opening identifier — POST { moves: [SAN,...] } OR GET ?moves=e4,c5,...
// Registered ABOVE /:slug so the slug matcher doesn't swallow 'identify'.
router.post(  '/chess/openings/identify',  postIdentifyOpening);
router.get(   '/chess/openings/identify',  postIdentifyOpening);
router.get(   '/chess/openings/:slug',     getOpeningDetail);

// Live online challenge matches
router.post(  '/chess/matches',             postCreateMatch);
router.post(  '/chess/matches/:id/join',    postJoinMatch);
router.get(   '/chess/matches/:id',         getMatchState);
router.post(  '/chess/matches/:id/move',    postMatchMove);
router.post(  '/chess/matches/:id/resign',  postResignMatch);
// Takeback request/accept/decline — opponent-approval flow, unlimited per match.
router.post(  '/chess/matches/:id/takeback/request', postTakebackRequest);
router.post(  '/chess/matches/:id/takeback/accept',  postTakebackAccept);
router.post(  '/chess/matches/:id/takeback/decline', postTakebackDecline);
// Lobby — deeper path than /:id so Express won't route-match it under :id.
router.get(   '/chess/matches/lobby/live',  listLiveMatches);

export default router;
