# sid-be / db

Local reference material for the SQLite database at `data/sid.db`.
**Nothing in this folder is required at runtime** — `app.js` never imports from
here. It's docs + one-off scripts that live alongside the code so they don't
rot.

## Layout

```
db/
├── README.md                 ← you are here
├── schema/
│   ├── ai-video.md           ← jobs, videos, failures, combined_videos, yt_jobs
│   ├── images.md             ← enhanced_images
│   ├── chat.md               ← chat_conversations, chat_messages, chat_jobs
│   ├── mesh.md               ← mesh_jobs
│   ├── deepfake-audio.md     ← deepfake_jobs, lipsync_jobs, audio_jobs
│   ├── room.md               ← room_jobs
│   ├── cinema.md             ← cinema_projects, cinema_renders, job_logs
│   ├── games.md              ← games_players, games_scores
│   └── chess.md              ← chess_games, chess_matches, chess_puzzles, users, attempts
├── indexes/
│   ├── apply-indexes.js      ← idempotent CREATE INDEX IF NOT EXISTS
│   └── query-audit.md        ← hot-query list + which index each one hits
└── notes/
    └── optimization.md       ← WAL, pragma choices, why we're on SQLite
```

## When to touch what

| Question | File |
|---|---|
| "What columns does table X have?" | `schema/<domain>.md` |
| "Do we have an index for this WHERE clause?" | `schema/<domain>.md` + `indexes/query-audit.md` |
| "How do I add a new index without a full migration framework?" | `indexes/apply-indexes.js` |
| "Why SQLite over Postgres?" | `notes/optimization.md` |

## Running the one-off index script

The script is not wired into boot. To apply new indexes to the live DB on
Oracle, SSH in and run:

```bash
cd /home/ubuntu/sid-be
node db/indexes/apply-indexes.js
```

Idempotent — every statement is `CREATE INDEX IF NOT EXISTS`. Safe to re-run.

## Rules

- Tables live in `services/aiVideo/db.js` (main store) and
  `services/chess/puzzleStore.js` (chess puzzles). New tables go in one of
  those two files, then get documented here.
- Every column in `schema/*.md` names the type + one-line purpose.
- Every new query in `controllers/**` that hits a large table must show up in
  `indexes/query-audit.md` with the index it uses. If none exists, add one to
  `apply-indexes.js`.
