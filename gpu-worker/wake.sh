#!/bin/bash
# wake.sh — pulls latest worker code from your BE, starts the polling worker.
# This is the ONE script that lives on Lightning. All bug fixes / updates ship
# from your BE; this script just re-fetches and restarts.
#
# Usage:  bash wake.sh

set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[wake] .env missing. First time? Create it:"
  echo "       cp .env.example .env && nano .env"
  exit 1
fi

set -a
. ./.env
set +a

REQUIRED=(MAIN_BACKEND_URL WORKER_TOKEN CLOUDINARY_CLOUD_NAME CLOUDINARY_API_KEY CLOUDINARY_API_SECRET)
for v in "${REQUIRED[@]}"; do
  if [ -z "${!v}" ]; then
    echo "[wake] $v is not set in .env"
    exit 1
  fi
done

echo "[wake] fetching latest code from $MAIN_BACKEND_URL ..."
for f in worker.py comfyui_client.py cloudinary_upload.py requirements.txt; do
  if curl -sSf -m 15 -H "Authorization: Bearer $WORKER_TOKEN" \
        -o "$f.new" "$MAIN_BACKEND_URL/api/gpu-worker/files/$f"; then
    mv "$f.new" "$f"
    echo "  ✓ $f"
  else
    rm -f "$f.new"
    echo "  ✗ $f (keeping local copy if any)"
    [ -f "$f" ] || { echo "[wake] critical file $f missing"; exit 1; }
  fi
done

echo "[wake] installing python deps..."
pip install -q -r requirements.txt

COMFY_URL="${COMFYUI_URL:-http://127.0.0.1:8000}"
echo "[wake] checking ComfyUI at $COMFY_URL ..."
if ! curl -fsS -m 4 "$COMFY_URL/system_stats" > /dev/null 2>&1; then
  echo "[wake] ComfyUI not running at $COMFY_URL"
  echo "       Open the ComfyUI tab in your Lightning Studio (auto-starts there)"
  echo "       OR: cd ~/ComfyUI && nohup python main.py --listen 127.0.0.1 --port 8000 > ~/comfy.log 2>&1 &"
  exit 1
fi
echo "[wake]   ComfyUI OK"

if pgrep -f "python worker.py" > /dev/null; then
  echo "[wake] killing existing worker..."
  pkill -f "python worker.py" || true
  sleep 2
fi

echo "[wake] starting worker..."
nohup python worker.py > worker.log 2>&1 &
sleep 4

echo ""
echo "============= worker.log (last 20 lines) ============="
tail -20 worker.log
echo "======================================================"
echo ""
echo "✅ Worker running."
echo "   Live tail:  tail -f ~/gpu-worker/worker.log"
echo "   Stop:       pkill -f 'python worker.py'"
echo "   Re-fix:     bash wake.sh   (always pulls latest from BE)"
