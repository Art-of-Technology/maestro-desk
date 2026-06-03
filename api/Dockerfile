# Bun + Hono API for Fly.io. The server runs persistent background workers
# (outgoing-webhook delivery + CSAT reminders), so it must stay always-on —
# see fly.toml (min_machines_running = 1, auto_stop_machines = off).
FROM oven/bun:1.3-alpine

WORKDIR /app

# Install deps first for layer caching. --production skips devDeps (typescript,
# @types/bun); Bun runs the .ts entrypoint directly, so no build step.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Fly routes to internal_port 8080; the server reads PORT (see lib/env.ts).
ENV PORT=8080
EXPOSE 8080

CMD ["bun", "src/index.ts"]
