# syntax=docker/dockerfile:1.7
# One image, two roles: the gateway (default CMD) and the worker
# (docker compose overrides the command). Also runs migrations and admin scripts.

ARG NODE_IMAGE=node:22.20-bookworm-slim

# ---- base: OS packages needed by Prisma's engines ---------------------------
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- build: compile TypeScript with dev dependencies ------------------------
FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ---- prod-deps: runtime dependencies only (+ generated Prisma client) -------
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund && npx prisma generate && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node examples ./examples
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000 9464
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
