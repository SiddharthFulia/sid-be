# Schema — Chess

Source: `services/aiVideo/db.js` (games, matches) + `services/chess/puzzleStore.js` (puzzles).

## `chess_games` — saved-game library

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `name` | TEXT NOT NULL | user-supplied |
| `pgn` | TEXT NOT NULL | full PGN |
| `fen` | TEXT NOT NULL | final position |
| `side` | TEXT | `white` \| `black` \| NULL |
| `mode` | TEXT NOT NULL | `play` \| `analyze` \| `human-vs-human` |
| `engineName` `engineType` | TEXT | e.g. `Stockfish` / `stockfish` |
| `engineStrength` | INTEGER | ELO 1320-3190 |
| `timeControl` | TEXT | `none` \| `bullet1` \| `blitz32` \| `custom` |
| `result` | TEXT NOT NULL DEFAULT '*' | `1-0` \| `0-1` \| `1/2-1/2` \| `*` |
| `moveCount` | INTEGER NOT NULL DEFAULT 0 | half-moves |
| `collection` | TEXT | user tag |
| `variant` | TEXT NOT NULL DEFAULT 'standard' | `standard`/`chess960`/`koth`/... |
| `startFen` | TEXT | 960 starting pos etc. |
| `movesUci` | TEXT | UCI move list (variant-safe) |
| `createdAt` `updatedAt` | TEXT NOT NULL | |

### Indexes

| Name | Columns |
|---|---|
| `idx_chess_games_updated` | `(updatedAt DESC)` |
| `idx_chess_games_result` | `(result, updatedAt DESC)` |
| `idx_chess_games_variant` | `(variant, updatedAt DESC)` |
| **NEW** `idx_chess_games_collection_updated` | `(collection, updatedAt DESC)` |

## `chess_matches` — live 1v1 via link share

No auth. `whiteSession` / `blackSession` random hex tokens.

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PK | short random id |
| `status` | TEXT NOT NULL DEFAULT 'waiting' | `waiting` \| `active` \| `completed` \| `aborted` |
| `whiteSession` | TEXT NOT NULL | 24-char hex |
| `blackSession` | TEXT | populated on 2nd-player join |
| `whiteName` `blackName` | TEXT | optional display names |
| `fen` | TEXT NOT NULL | current position |
| `pgn` | TEXT NOT NULL DEFAULT '' | growing PGN |
| `sideToMove` | TEXT NOT NULL DEFAULT 'w' | `w` \| `b` |
| `moveCount` | INTEGER NOT NULL DEFAULT 0 | half-moves |
| `result` | TEXT NOT NULL DEFAULT '*' | |
| `timeControlId` `baseMs` `incMs` `whiteMs` `blackMs` | | Fischer clocks |
| `whiteLastSeenAt` `blackLastSeenAt` | TEXT | per-side heartbeat for auto-abort |
| `takebackRequest` | TEXT | JSON `{requestedBy, requestedAtPly, plyToRevertTo, requestedAt}` or NULL |
| `createdAt` `updatedAt` `lastMoveAt` `completedAt` | TEXT | |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_chess_matches_status` | `(status, updatedAt DESC)` | live-match dashboard |
| **NEW** `idx_chess_matches_white_session` | `(whiteSession)` | session validation |
| **NEW** `idx_chess_matches_black_session` | `(blackSession)` | session validation |

## `chess_puzzles` — imported Lichess library (~100k rows)

Read-mostly. Rating brackets are computed at fetch time per user's current
rating (never fixed at insert-time).

| Column | Type | Purpose |
|---|---|---|
| `puzzle_id` | TEXT PK | Lichess id |
| `fen` | TEXT NOT NULL | starting position |
| `moves` | TEXT NOT NULL | space-separated UCI solution |
| `rating` | INTEGER NOT NULL | Glicko 600-3000 |
| `popularity` `nb_plays` | INTEGER | |
| `themes` | TEXT | space-separated theme tags |
| `game_url` `opening_tags` | TEXT | |

### Indexes

| Name | Columns |
|---|---|
| `idx_puzzles_rating` | `(rating)` |
| `idx_puzzles_themes` | `(themes)` |

## `chess_puzzle_users`

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `name` | TEXT NOT NULL UNIQUE | |
| `rating` | INTEGER NOT NULL DEFAULT 1000 | current Glicko-ish |
| `solved_count` | INTEGER NOT NULL DEFAULT 0 | cumulative |
| `created_at` `last_active_at` | INTEGER | epoch |

## `chess_puzzle_attempts`

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `user_id` | INTEGER NOT NULL FK CASCADE | ref `chess_puzzle_users.id` |
| `puzzle_id` | TEXT NOT NULL | soft ref |
| `success` | INTEGER NOT NULL | 0/1 |
| `attempts_used` | INTEGER NOT NULL DEFAULT 1 | 1..3 |
| `rating_delta` | INTEGER NOT NULL | signed |
| `viewed_solution` | INTEGER NOT NULL DEFAULT 0 | 0/1 |
| `difficulty` | TEXT | `easy` \| `medium` \| `hard` |
| `created_at` | INTEGER NOT NULL | epoch |

### Indexes

| Name | Columns |
|---|---|
| `idx_attempts_user_success` | `(user_id, success)` |
| `idx_attempts_user_puzzle` | `(user_id, puzzle_id)` |
| **NEW** `idx_attempts_user_created` | `(user_id, created_at DESC)` |
