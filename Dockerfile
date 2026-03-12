FROM oven/bun:1.3.5-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.5-alpine
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

RUN mkdir -p /data && chown bun:bun /data

ENV DB_PATH=/data/janitor-throws.db
EXPOSE 3000

USER bun

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/health || exit 1

CMD ["bun", "run", "src/cli/daemon.ts"]
