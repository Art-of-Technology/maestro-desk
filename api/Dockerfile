# Respovia API — self-hosted (Dokploy) image. Build context = api/ (set
# "Docker Context Path" to api in Dokploy). Bun runs the TypeScript sources
# directly; there is no build/transpile step. Runtime entry is src/server.ts
# (always-on Bun.serve + in-process webhook worker) — NOT src/index.ts, which
# is the Vercel serverless export.
# Pin the exact Bun from package.json's packageManager (bun@1.3.13).
FROM oven/bun:1.3.13

WORKDIR /app

# Install deps first so image layers cache until the lockfile changes.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
USER bun
EXPOSE 3001

# Liveness only (no DB roundtrip) — readiness is /api/v1/health/ready/neon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/v1/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/server.ts"]
