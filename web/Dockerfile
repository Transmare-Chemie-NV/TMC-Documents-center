# TMC Document Center web app container for Azure Container Apps (or Azure App Service).
# Build from the repository root:
#   docker build -f web/Dockerfile -t tmc-web .
# Runs database migrations at startup when DATABASE_URL is set, then starts Next.js standalone.
# Base image pinned by digest for reproducible builds (SEC-12).
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS builder
WORKDIR /app/web
COPY --from=deps /app/web/node_modules ./node_modules
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_STANDALONE=1
# Placeholder secret scoped strictly to the build RUN command (never persisted in image ENV layers, SEC-12).
RUN AUTH_SECRET=build-only-placeholder-secret-never-used-at-runtime-000 npx next build

# Minimal lockfile-verified dependencies for scripts/migrate.mjs only (keeps standalone node_modules pruned, SEC-12 / M2).
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS migrator-deps
WORKDIR /app/migrate
COPY web/scripts/migrate/package.json web/scripts/migrate/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS runner
WORKDIR /app/web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Standalone app, static assets, public files (all owned by root: read-only for node).
COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/.next/static ./.next/static
COPY --from=builder /app/web/public ./public
COPY --from=builder /app/web/drizzle ./drizzle
# Isolated migration runner in /app/migrate so standalone node_modules stays minimal (no pglite/tsx).
COPY --from=migrator-deps /app/migrate/node_modules /app/migrate/node_modules
COPY --from=builder /app/web/scripts/migrate.mjs /app/migrate/scripts/migrate.mjs
COPY --from=builder /app/web/lib/db/pg-config.mjs /app/migrate/lib/db/pg-config.mjs

USER node
EXPOSE 3000
CMD ["sh", "-c", "node /app/migrate/scripts/migrate.mjs && exec node server.js"]
