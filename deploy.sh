#!/usr/bin/env bash
# Deploy the docs/ WebGL app (with the audio-reactive additions) to
# ell.ing/fluoddity-audio. Static files only -- no build step, no backend, no
# service to restart. Just rsync + a smoke test.
set -euo pipefail

SSH_KEY="${FLUAUDIO_SSH_KEY:-/Users/nickel/Claudecode/helpy/helpy-claude.pem}"
HOST="${FLUAUDIO_HOST:-ubuntu@32.193.44.115}"
REMOTE="${FLUAUDIO_REMOTE_DIR:-/var/www/fluoddity-audio}"

cd "$(dirname "$0")"

echo "[deploy] rsync docs/ -> $HOST:$REMOTE/"
rsync -az --delete -e "ssh -i $SSH_KEY -o LogLevel=ERROR" \
  --exclude 'CLAUDE.md' \
  docs/ "$HOST:$REMOTE/"

echo "[deploy] smoke test:"
for path in /fluoddity-audio/ /fluoddity-audio/main.js /fluoddity-audio/audio.js; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "https://ell.ing$path")
  printf "  https://ell.ing%-20s -> %s\n" "$path" "$code"
done

echo "[deploy] done -- https://ell.ing/fluoddity-audio/"
