#!/bin/sh
# One backup pass: pg_dump -Fc → private S3-compatible bucket → prune.
#
# Required env (set in the Dokploy application, never in the image):
#   POSTGRES_HOST POSTGRES_DATABASE POSTGRES_USER POSTGRES_PASSWORD
#   S3_ENDPOINT S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
# Optional: S3_PREFIX (default nightly), KEEP_COUNT (default 14),
#           AWS_DEFAULT_REGION (default auto — R2 convention)
#
# The dump goes to a temp file first so the upload only happens when pg_dump
# exited 0 — a failed dump can never push a truncated artifact.
set -eu

: "${S3_PREFIX:=nightly}"
: "${KEEP_COUNT:=14}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
export PGPASSWORD="$POSTGRES_PASSWORD"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=/tmp/backup-$STAMP.dump
KEY="s3://$S3_BUCKET/$S3_PREFIX/respovia-$STAMP.dump"

echo "[backup] dumping $POSTGRES_DATABASE from $POSTGRES_HOST"
pg_dump -Fc -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DATABASE" > "$TMP"

echo "[backup] uploading $(wc -c < "$TMP") bytes to $KEY"
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$TMP" "$KEY" --only-show-errors
rm -f "$TMP"

# Prune: keep the newest $KEEP_COUNT dumps (keys embed a sortable UTC stamp).
# awk buffers the sorted list and prints all but the last KEEP_COUNT —
# `head -n -N` is a GNU extension BusyBox doesn't have.
aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://$S3_BUCKET/$S3_PREFIX/" \
  | awk '{print $NF}' | grep '\.dump$' | sort \
  | awk -v k="$KEEP_COUNT" '{a[NR]=$0} END{for(i=1;i<=NR-k;i++) print a[i]}' \
  | while read -r f; do
      [ -n "$f" ] || continue
      echo "[backup] pruning $f"
      aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://$S3_BUCKET/$S3_PREFIX/$f" --only-show-errors
    done

echo "[backup] done: $KEY"
