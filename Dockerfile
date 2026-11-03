# syntax=docker/dockerfile:1

# ---- web console -------------------------------------------------------------
# Built first so the runtime image never carries node_modules or a bundler.
FROM oven/bun:1.3-alpine AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock* ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# ---- runtime -----------------------------------------------------------------
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# Copy only what the server needs; no dev dependencies, no TypeScript sources
# beyond the ones Bun executes directly.
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --production --frozen-lockfile

COPY src/ ./src/
COPY --from=web /app/web/dist ./web/dist

# Run unprivileged. The container holds a credential capable of trading, so it
# must never run as root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787

# The health endpoint is behind BRIDGE_TOKEN, so the probe must present it.
# CMD-SHELL form, not exec: the token has to be expanded at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD-SHELL wget -q -T 3 -O /dev/null --header="Authorization: Bearer ${BRIDGE_TOKEN}" "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["bun", "src/server.ts"]
