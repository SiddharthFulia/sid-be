// Stockfish wrapper for the /api/chess/* lane.
//
// Uses node-uci which spawns the system `stockfish` binary and talks UCI
// over stdin/stdout. On Oracle Ubuntu ARM: `apt install stockfish`
// drops the binary at /usr/games/stockfish — set STOCKFISH_PATH env var
// to override (e.g. /usr/local/bin/stockfish on Mac, custom build path).
//
// Each request gets a fresh Engine instance (cheap to spin up, prevents
// state bleed between concurrent requests). For hot-loop use later we
// can pool, but for portfolio traffic this is fine.

import { Engine } from 'node-uci';
import logger from '../../helpers/logger.js';

const STOCKFISH_PATH = process.env.STOCKFISH_PATH || 'stockfish';

const DEFAULT_DEPTH = 14;          // ~1700 elo with 1ms/move; tunable per request
const MAX_DEPTH = 24;
const DEFAULT_THINK_MS = 800;       // hard cap on think time so the BE doesn't hang
const MAX_THINK_MS = 5000;
const MAX_MULTI_PV = 5;

// Single global flag — set true the first time we successfully spawn the
// binary, false once on permanent failure. Stops endpoints retrying when
// stockfish isn't installed at all.
let _binaryStatus = 'unknown';   // 'unknown' | 'ok' | 'missing'

async function withEngine(fn) {
  if (_binaryStatus === 'missing') {
    throw new Error(`Stockfish binary not found at "${STOCKFISH_PATH}". Run: apt install stockfish (Ubuntu) or set STOCKFISH_PATH.`);
  }
  const engine = new Engine(STOCKFISH_PATH);
  try {
    await engine.init();
    _binaryStatus = 'ok';
    await engine.isready();
    return await fn(engine);
  } catch (e) {
    // ENOENT → binary missing. Cache so subsequent requests fail fast
    // without trying to spawn again.
    if (e && (e.code === 'ENOENT' || /spawn .* ENOENT/.test(String(e.message)))) {
      _binaryStatus = 'missing';
      throw new Error(`Stockfish binary not found at "${STOCKFISH_PATH}". Run: apt install stockfish (Ubuntu) or set STOCKFISH_PATH.`);
    }
    throw e;
  } finally {
    try { await engine.quit(); } catch { /* engine may already be dead */ }
  }
}

// Convert raw UCI score → { type: 'cp' | 'mate', value: number, side: 'w' | 'b' }
// Stockfish scores are FROM THE SIDE TO MOVE; we normalize to white's
// perspective so the FE eval graph can plot a single signed line.
function normalizeScore(rawScore, sideToMoveIsWhite) {
  if (!rawScore) return null;
  // node-uci shape: { unit: 'cp' | 'mate', value: Number }
  const value = sideToMoveIsWhite ? rawScore.value : -rawScore.value;
  return { type: rawScore.unit, value };
}

// Detect side-to-move from a FEN (the 2nd whitespace token: 'w' or 'b').
function fenSideToMoveIsWhite(fen) {
  const parts = String(fen || '').trim().split(/\s+/);
  return parts[1] !== 'b';
}

/**
 * Top engine move + eval for a FEN. Pure analysis — doesn't model rating.
 *   { fen, depth?, thinkMs? }
 * Returns { bestmove (UCI), ponder, score, depth, pv (UCI array) }.
 */
export async function bestMove({ fen, depth = DEFAULT_DEPTH, thinkMs = DEFAULT_THINK_MS } = {}) {
  const d = Math.min(Math.max(parseInt(depth, 10) || DEFAULT_DEPTH, 1), MAX_DEPTH);
  const t = Math.min(Math.max(parseInt(thinkMs, 10) || DEFAULT_THINK_MS, 50), MAX_THINK_MS);
  const whiteToMove = fenSideToMoveIsWhite(fen);

  return withEngine(async (engine) => {
    await engine.setoption('MultiPV', '1');
    await engine.position(fen);
    // Go with both depth AND movetime — whichever finishes first.
    const result = await engine.go({ depth: d, movetime: t });
    const lastInfo = (result.info || []).filter(i => i.score).pop();
    return {
      bestmove: result.bestmove || null,
      ponder: result.ponder || null,
      score: lastInfo ? normalizeScore(lastInfo.score, whiteToMove) : null,
      depth: lastInfo?.depth ?? d,
      seldepth: lastInfo?.seldepth ?? null,
      pv: lastInfo?.pv ? lastInfo.pv.split(' ') : [],
      nodes: lastInfo?.nodes ?? null,
      nps: lastInfo?.nps ?? null,
    };
  });
}

/**
 * Multi-PV analysis — top N moves with eval. Used by the "best moves"
 * sidebar and the move-list per-position scoring.
 *   { fen, multiPv = 3, depth = 12, thinkMs = 800 }
 */
export async function analyze({ fen, multiPv = 3, depth = 12, thinkMs = DEFAULT_THINK_MS } = {}) {
  const n = Math.min(Math.max(parseInt(multiPv, 10) || 3, 1), MAX_MULTI_PV);
  const d = Math.min(Math.max(parseInt(depth, 10) || 12, 1), MAX_DEPTH);
  const t = Math.min(Math.max(parseInt(thinkMs, 10) || DEFAULT_THINK_MS, 50), MAX_THINK_MS);
  const whiteToMove = fenSideToMoveIsWhite(fen);

  return withEngine(async (engine) => {
    await engine.setoption('MultiPV', String(n));
    await engine.position(fen);
    const result = await engine.go({ depth: d, movetime: t });
    // node-uci accumulates `info` lines; we want the LAST `info` per
    // multipv slot at the deepest depth. Walk backwards.
    const byMultipv = new Map();
    for (let i = result.info.length - 1; i >= 0; i--) {
      const info = result.info[i];
      if (!info.score || info.multipv == null) continue;
      if (!byMultipv.has(info.multipv)) byMultipv.set(info.multipv, info);
      if (byMultipv.size === n) break;
    }
    const variations = [];
    for (const [mpv, info] of [...byMultipv.entries()].sort((a, b) => a[0] - b[0])) {
      variations.push({
        rank: mpv,
        score: normalizeScore(info.score, whiteToMove),
        depth: info.depth ?? d,
        pv: info.pv ? info.pv.split(' ') : [],
      });
    }
    return {
      bestmove: result.bestmove || null,
      variations,
    };
  });
}

/**
 * Rating-locked play. Caps Stockfish strength via UCI_LimitStrength +
 * UCI_Elo (engine itself models the noise — much cleaner than us
 * mangling the eval).
 *   { fen, elo = 1500, thinkMs = 400 }
 */
export async function play({ fen, elo = 1500, thinkMs = 400 } = {}) {
  // Stockfish's Elo range is 1320..3190 in modern builds; clamp to that.
  const e = Math.min(Math.max(parseInt(elo, 10) || 1500, 1320), 3190);
  const t = Math.min(Math.max(parseInt(thinkMs, 10) || 400, 50), MAX_THINK_MS);

  return withEngine(async (engine) => {
    await engine.setoption('UCI_LimitStrength', 'true');
    await engine.setoption('UCI_Elo', String(e));
    await engine.setoption('MultiPV', '1');
    await engine.position(fen);
    const result = await engine.go({ movetime: t });
    return {
      bestmove: result.bestmove || null,
      eloUsed: e,
      thinkMs: t,
    };
  });
}

export function engineStatus() {
  return {
    path: STOCKFISH_PATH,
    status: _binaryStatus,
    defaults: { depth: DEFAULT_DEPTH, thinkMs: DEFAULT_THINK_MS, multiPv: 3 },
  };
}
