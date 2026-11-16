# syntax=docker/dockerfile:1
# The tests build their databases with the infra repo's migration runner (D-039). Pass that folder in as a named
# build context:  docker build --build-context db=../fitmanager-infra/db .
# The production image holds no migrations: the API never changes the schema.
# Same flow as the frontends' images: deps → test (blocks the build on a failing check) → production image.
# Compared with the services' `arnabb38/node18-oracleclient-bullseye` image: Node 18 is end-of-life (April 2025),
# `npm install` (not `npm ci`) ignored the lock file, dev dependencies shipped, and the app ran as root.

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

FROM deps AS test
COPY . .
# At ../fitmanager-infra/db relative to /app, where src/testing/test-app.ts imports it from.
COPY --from=db tools /fitmanager-infra/db/tools
COPY --from=db migrations /fitmanager-infra/db/migrations
COPY --from=db seeds /fitmanager-infra/db/seeds
RUN npm run format:check && npm run typecheck && npm run lint && npx vitest run

FROM node:26-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine
# Chromium + fonts for server-side PDFs (Noto Sans Bengali shapes Bangla); tini forwards SIGTERM so the graceful
# shutdown in server.ts runs.
RUN apk add --no-cache chromium font-noto font-noto-bengali tini
ARG APP_VERSION=unknown
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    CHROME_PATH=/usr/bin/chromium \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=test /app/package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node src ./src
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Node runs the TypeScript sources directly (type stripping); /app/.env is where the Swarm config is mounted.
CMD ["node", "--env-file-if-exists=/app/.env", "--import", "./src/instrument.ts", "src/server.ts"]
