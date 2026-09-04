# Schema — Runner game

Source: `services/aiVideo/db.js`.

Subway-Surfers-style endless runner. No auth — a nickname is the identity.

## `games_players`

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `name` | TEXT NOT NULL UNIQUE COLLATE NOCASE | nickname |
| `createdAt` | TEXT NOT NULL | |
| `lastPlayedAt` | TEXT | |

### Indexes

| Name | Columns |
|---|---|
| `idx_games_players_lastplayed` | `(lastPlayedAt DESC)` |

## `games_scores`

Denormalized `playerName` so the leaderboard doesn't need a JOIN.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK autoincrement | |
| `playerId` | INTEGER NOT NULL FK CASCADE | ref `games_players.id` |
| `playerName` | TEXT NOT NULL | denormalised for fast leaderboard |
| `score` | INTEGER NOT NULL | |
| `distance` | INTEGER NOT NULL | meters at game-end |
| `difficulty` | TEXT NOT NULL | `easy` \| `medium` \| `hard` \| `classic` |
| `revived` | INTEGER NOT NULL DEFAULT 0 | 0/1 |
| `createdAt` | TEXT NOT NULL | |

### Indexes

| Name | Columns | Query |
|---|---|---|
| `idx_games_scores_score` | `(score DESC)` | global leaderboard |
| `idx_games_scores_diff_score` | `(difficulty, score DESC)` | per-difficulty board |
| `idx_games_scores_player_created` | `(playerId, createdAt DESC)` | player history |
