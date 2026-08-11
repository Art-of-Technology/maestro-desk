# Respovia API — self-hosted (Dokploy) image. Build context = api/ (set
# "Docker Context Path" to api in Dokploy).
#
# The runtime is NODE, not Bun, on purpose: the connect-time SSRF guard on
# outbound webhook deliveries (lib/ssrf.ts safeLookup through an undici Agent,
# hardening PR #412) only engages on Node — Bun's fetch ignores undici
# dispatchers and node:https custom lookups (verified empirically), which
# would silently drop the DNS-rebinding protection. Vercel production runs
# Node too, so this keeps runtime parity. Bun is used only to install deps
# (bun.lock is the lockfile) — pinned to package.json's packageManager.
# tsx (a production dependency) lets Node run the TypeScript sources directly,
# matching the repo's no-build-step convention.
FROM oven/bun:1.3.13 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER node
EXPOSE 3001

# Liveness only (no DB roundtrip) — readiness is /api/v1/health/ready/neon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]
