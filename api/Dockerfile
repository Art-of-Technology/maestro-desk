# Respovia API — self-hosted (Dokploy) image. Build context = REPO ROOT (set
# "Docker Context Path" to . and "Dockerfile" to api/Dockerfile in Dokploy):
# the image needs db/migrations/ (repo root) alongside api/ so migrations can
# run at container boot. The image mirrors the repo layout (/app/api +
# /app/db/migrations) so migrate.ts's ../../db/migrations path math works
# unchanged; the root .dockerignore keeps the context lean and secret-free.
#
# The runtime is NODE, not Bun, on purpose: the connect-time SSRF guard on
# outbound webhook deliveries (lib/ssrf.ts safeLookup through an undici Agent,
# hardening PR #412) only engages on Node — Bun's fetch ignores undici
# dispatchers and node:https custom lookups (verified empirically), which
# would silently drop the DNS-rebinding protection. Bun is used only to
# install deps (bun.lock is the lockfile) — pinned to package.json's
# packageManager. tsx (a production dependency) lets Node run the TypeScript
# sources directly, matching the repo's no-build-step convention.
FROM oven/bun:1.3.13 AS deps
WORKDIR /app/api
COPY api/package.json api/bun.lock api/bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM node:22-slim
WORKDIR /app/api
ENV NODE_ENV=production
COPY --from=deps /app/api/node_modules ./node_modules
COPY api/package.json api/tsconfig.json ./
COPY api/src ./src
COPY api/scripts/migrate.ts ./scripts/migrate.ts
COPY db/migrations /app/db/migrations
USER node
EXPOSE 3001

# Liveness only (no DB roundtrip) — readiness is /api/v1/health/ready.
# start-period is generous because boot now includes the migration pass; a
# deploy shipping a slow migration must not eat into the healthcheck retries.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Apply pending migrations, then start. `exec` hands PID 1 to the server so
# SIGTERM reaches its drain handler on stop/redeploy (sh would swallow it).
# A failed migration aborts the boot: the new container never goes healthy and
# the previous image keeps serving (it doesn't contain the bad file).
CMD ["sh", "-c", "node --import tsx scripts/migrate.ts && exec node --import tsx src/server.ts"]
