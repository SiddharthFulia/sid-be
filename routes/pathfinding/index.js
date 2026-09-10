// /pathfinding/* — Pathfinding lab endpoints.
//
// Currently just the AI recommender that suggests real places for a
// natural-language query ("italian restaurant in bandra"). The FE
// takes each returned name and matches it against the city_places
// table via /api/city-graphs/:slug/places for real coordinates.
//
// The graph + fuzzy place search still live under /api/city-graphs
// (see routes/cityGraphs/index.js) — this router is scoped to the
// value-add layers on top of that data.

import { Router } from 'express';
import { postRecommend } from '../../controllers/pathfinding/recommend.js';

const router = Router();

router.post('/pathfinding/recommend', postRecommend);

export default router;
