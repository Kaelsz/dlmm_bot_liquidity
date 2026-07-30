#!/usr/bin/env bash
# Bring the paper run back after a container rollback.
#
# This environment restores the container from a fixed snapshot every ~30
# minutes, which rewinds both the working tree and the database. Git is the
# only durable storage, so recovery is: reset to origin (the bot pushes its
# own state there every 5 minutes, merging rather than overwriting), then
# restart the supervised run for whatever is left of the window.
#
# Idempotent: exits quietly if the run is already alive or the window closed.
set -u

END_MS=${1:?usage: resume-run.sh <end-epoch-ms> [logfile]}
LOG=${2:-data/run24h-v3.log}

if pgrep -f "supervise-paper.sh" >/dev/null; then
  echo "run already alive"
  exit 0
fi

now_ms=$(date +%s%3N)
if [ "$now_ms" -ge "$END_MS" ]; then
  echo "window closed"
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch origin "$BRANCH" >/dev/null 2>&1 && git reset --hard "origin/$BRANCH" >/dev/null 2>&1

chmod +x scripts/*.sh
nohup scripts/supervise-paper.sh "$END_MS" "$LOG" >/dev/null 2>&1 &
echo "restarted, $(( (END_MS - now_ms) / 60000 )) min left in window"
