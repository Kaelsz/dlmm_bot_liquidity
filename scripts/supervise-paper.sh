#!/usr/bin/env bash
# Keeps a paper run alive until a deadline.
#
# The remote container this runs in restarts and rolls back without warning;
# three runs were lost that way. The bot itself pushes its state to git every
# 10 minutes, and this wrapper covers the other half: if the process dies while
# the container survives, restart it instead of leaving the window empty.
#
# Usage: scripts/supervise-paper.sh <end-epoch-ms> [logfile]
set -u

END_MS=${1:?usage: supervise-paper.sh <end-epoch-ms> [logfile]}
LOG=${2:-data/run.log}

now_ms() { date +%s%3N; }

while [ "$(now_ms)" -lt "$END_MS" ]; do
  echo "[supervisor] starting bot at $(date -u +%FT%TZ)" >>"$LOG"
  npx tsx src/index.ts paper >>"$LOG" 2>&1
  echo "[supervisor] bot exited (code $?) at $(date -u +%FT%TZ)" >>"$LOG"
  [ "$(now_ms)" -lt "$END_MS" ] || break
  sleep 10
done

echo "[supervisor] deadline reached at $(date -u +%FT%TZ)" >>"$LOG"
