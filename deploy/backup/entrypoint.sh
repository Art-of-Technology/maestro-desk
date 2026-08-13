#!/bin/sh
# Register the cron schedule (default nightly 02:00 UTC) and optionally run a
# backup immediately (RUN_ON_STARTUP=true — used to verify a fresh deploy
# without waiting for the schedule).
#
# BusyBox crond starts jobs with a near-empty environment — it does NOT
# inherit the container's env vars. Snapshot them here (properly quoted via
# `export -p`) and source the snapshot in the cron job; job output is
# redirected to PID 1's stdout so backups show up in `docker logs`.
set -eu

: "${SCHEDULE:=0 2 * * *}"

export -p > /etc/backup.env
chmod 600 /etc/backup.env

echo "$SCHEDULE . /etc/backup.env; /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" | crontab -
echo "[backup-sidecar] schedule registered: $SCHEDULE"

if [ "${RUN_ON_STARTUP:-false}" = "true" ]; then
  echo "[backup-sidecar] RUN_ON_STARTUP=true — running an immediate backup"
  /usr/local/bin/backup.sh || echo "[backup-sidecar] startup backup FAILED (cron schedule still armed)"
fi

exec crond -f -l 2
