# Respovia DB-backup sidecar — runs as the Dokploy application
# `respovia-db-backup` (custom-git build, Docker Context Path = deploy/backup).
#
# pg_dump (v17 client, matching the respovia-db server) + aws-cli (R2 is
# S3-compatible) + crond. All configuration comes from Dokploy env vars —
# see backup.sh for the contract. No secrets live in this image.
FROM postgres:17-alpine

RUN apk add --no-cache aws-cli

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Root is required for crond on Alpine; the container touches nothing but
# /tmp and the network.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
