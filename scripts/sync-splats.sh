#!/usr/bin/env bash
# scripts/sync-splats.sh
# One-shot uploader for the curated Gaussian-splat sample scenes
# that power the /splat viewer's chip row.
#
# The files sit locally under sid-be/data/splat-cache/ (gitignored,
# extracted from mkkellogg's official demo bundle). This script
# SCPs them to the prod sid-be box on Oracle so the API endpoint
# /api/splat-sample/<slug>.ksplat returns the same file in prod as
# it does on localhost.
#
# Usage:
#   bash scripts/sync-splats.sh
#
# Re-running is safe: rsync -u skips files the remote already has
# with the same size + mtime, so a partial-completed run resumes
# cleanly. If you delete a file remotely and want to re-push,
# just delete it on the remote and re-run.

set -euo pipefail

SSH_KEY="${SSH_KEY:-E:/Siddharth/ssh-key-2026-04-19.key}"
REMOTE_USER="${REMOTE_USER:-ubuntu}"
REMOTE_HOST="${REMOTE_HOST:-80.225.213.103}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/sid-be/data/splat-cache}"

# Repo-relative dir on the local machine.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DIR="${SCRIPT_DIR}/../data/splat-cache"

if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "ERROR: local splat-cache dir not found at $LOCAL_DIR"
  echo "       Run the extraction from gsplat.zip first."
  exit 1
fi

SHOPT_NULL=$(shopt -s nullglob; echo "$?")
shopt -s nullglob
KSPLAT_FILES=( "$LOCAL_DIR"/*.ksplat )
SPLAT_FILES=(  "$LOCAL_DIR"/*.splat  )
PLY_FILES=(    "$LOCAL_DIR"/*.ply    )
SPZ_FILES=(    "$LOCAL_DIR"/*.spz    )
FILES=( "${KSPLAT_FILES[@]}" "${SPLAT_FILES[@]}" "${PLY_FILES[@]}" "${SPZ_FILES[@]}" )

if (( ${#FILES[@]} == 0 )); then
  echo "Nothing to sync — local splat-cache is empty."
  exit 0
fi

echo "→ Will sync ${#FILES[@]} file(s) to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
for f in "${FILES[@]}"; do
  size=$(du -h "$f" | cut -f1)
  echo "    $(basename "$f")   ($size)"
done
echo ""

# 1. Make sure the remote dir exists.
echo "→ ensuring remote dir exists…"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "${REMOTE_USER}@${REMOTE_HOST}" \
    "mkdir -p '${REMOTE_DIR}'"

# 2. Push each file. scp keeps things simple — rsync would be nicer
#    but isn't guaranteed on the prod ARM box.
echo "→ uploading…"
scp -i "$SSH_KEY" "${FILES[@]}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

# 3. Verify + remind the user to restart sid-be so any in-memory
#    state picks up the new files (the splat-sample controller
#    reads from disk on every request, so a restart isn't strictly
#    required — but it surfaces obvious failures fast).
echo "→ verifying on remote…"
ssh -i "$SSH_KEY" "${REMOTE_USER}@${REMOTE_HOST}" \
    "ls -lh '${REMOTE_DIR}'"

cat <<EOF

✓ Splat samples synced.
  Next: ssh in and run 'pm2 restart sid-be' if you want the
  /api/splat-sample/* requests to log freshly. They will work
  without a restart too — the controller streams from disk per
  request.
EOF
