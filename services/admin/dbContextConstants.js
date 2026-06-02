// Curated per-table context for the Groq Q&A path. Used when the user
// has a table selected in the explorer — we send ONLY that table's
// schema + the entry below, instead of dumping every table.
// Tables not listed here fall back to schema-only (still works, just less
// semantic context for the model).
//
// Keep each entry MINIMAL — purpose: one short line, notes: only enums /
// join hints / JSON shapes the model can't infer from column names. The
// goal is token-cheap, not exhaustive prose.

export const TABLE_CONTEXT = {
  chess_games: {
    purpose: 'Saved chess games library.',
    notes: [
      'variant ∈ {standard, chess960, koth, threeCheck, atomic, antichess, horde, crazyhouse, racingKings, offline}',
      'result ∈ {"1-0","0-1","1/2-1/2","*"}; mode is "play"/"analyze"/"human-vs-human"',
      'movesUci = space-separated UCI; startFen = null for std default',
    ],
  },
  chess_matches: {
    purpose: 'Live online chess matches (link-shared).',
    notes: [
      'status ∈ {active, completed, abandoned}; sideToMove ∈ {w,b}',
      'whiteMs/blackMs are Fischer clocks (ms); takebackRequest is JSON or null',
    ],
  },
  chess_puzzles: {
    purpose: 'Lichess tactical puzzles (~100k).',
    notes: [
      'rating ≈ Glicko 600-3000; themes = space-separated tags; moves = UCI solution',
    ],
  },
  chess_puzzle_users: {
    purpose: 'Puzzle-trainer profiles (anyone can create).',
    notes: ['rating starts at 1000; solved_count is cumulative'],
  },
  chess_puzzle_attempts: {
    purpose: 'Per-attempt log for the puzzle trainer.',
    notes: [
      'success ∈ {0,1}; attempts_used ∈ {1,2,3}',
      'JOIN chess_puzzle_users on user_id, chess_puzzles on puzzle_id',
    ],
  },
  ai_videos: {
    purpose: 'Generated AI videos.',
    notes: [
      'provider ∈ {zsky, worker, optimized, beast}',
      'status ∈ {queued, processing, completed, failed}',
    ],
  },
  mesh_jobs: {
    purpose: '3D mesh generation jobs.',
    notes: [
      'engine ∈ {shap-e, triposr, trellis, trellis-v2, hunyuan3d}',
      'status ∈ {queued, processing, completed, failed}',
    ],
  },
  image_jobs: {
    purpose: 'Image enhancement / FLUX jobs.',
    notes: ['type ∈ {fast,slow}; engine ∈ {cloud,5090}'],
  },
  chat_conversations: {
    purpose: 'AI chat threads.',
    notes: ['archived ∈ {0,1}; provider ∈ {5090, cloud-groq, cloud-gemini}'],
  },
  chat_jobs: {
    purpose: 'Per-message chat-inference jobs.',
    notes: ['status ∈ {queued, processing, completed, failed}'],
  },
  combine_jobs: {
    purpose: 'ffmpeg multi-video concat jobs.',
    notes: ['sources is JSON array'],
  },
  cinema_projects: {
    purpose: 'Cinema multi-shot projects.',
    notes: ['shotPrompts is JSON array'],
  },
  cinema_renders: {
    purpose: 'Cinema render attempts (resumable per-render state).',
    notes: ['shotJobIds joins to ai_videos'],
  },
  games_players: { purpose: 'Endless-runner players.' },
  games_scores: {
    purpose: 'Endless-runner leaderboard.',
    notes: ['difficulty ∈ {easy,medium,hard,classic}; JOIN games_players on playerName'],
  },
  room_jobs: {
    purpose: 'AI Room Designer jobs (sweep video → render).',
    notes: ['status ∈ {queued, analyzing, ready, rendering, completed, failed}'],
  },
  ytdl_jobs: {
    purpose: 'YouTube downloader jobs (yt-dlp).',
  },
};

export function getTableContext(name) {
  return TABLE_CONTEXT[name] || null;
}
