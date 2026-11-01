# The Trade Request demo image. Build it from the repository root, where the npm workspaces and the
# lockfile live:  docker build -f apps/trade/Dockerfile --platform linux/amd64 .
# Cloudflare Containers run it behind the Worker in apps/trade/worker (which builds it on deploy).

FROM node:22-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS base
# Build-only stage; no long-running process to probe.
HEALTHCHECK NONE
WORKDIR /app

# Every workspace's package.json, so npm ci can check the lockfile; only the trade packages install.
COPY package.json package-lock.json ./
COPY synthetic/package.json ./synthetic/
COPY site/package.json ./site/
COPY apps/trade/package.json ./apps/trade/
COPY apps/trade/shared/package.json ./apps/trade/shared/
COPY apps/trade/server/package.json ./apps/trade/server/
COPY apps/trade/client/package.json ./apps/trade/client/
COPY apps/trade/worker/package.json ./apps/trade/worker/
COPY apps/acat/package.json ./apps/acat/

RUN npm ci --ignore-scripts --workspace=apps/trade/shared --workspace=apps/trade/server --workspace=apps/trade/client

COPY apps/trade/tsconfig.base.json ./apps/trade/
COPY apps/trade/shared/ ./apps/trade/shared/
COPY apps/trade/server/ ./apps/trade/server/
COPY apps/trade/client/ ./apps/trade/client/

# The public demo links back to the portfolio site (client/src/components/PortfolioLink.tsx).
ARG VITE_PORTFOLIO_URL=https://jeremyhamann.dev
RUN npm run build -w @trade-request/shared && \
    npm run build -w @trade-request/client && \
    npm run build -w @trade-request/server

FROM node:22-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS deps
# Dependency-only stage; no long-running process to probe.
HEALTHCHECK NONE
WORKDIR /app

COPY package.json package-lock.json ./
COPY synthetic/package.json ./synthetic/
COPY site/package.json ./site/
COPY apps/trade/package.json ./apps/trade/
COPY apps/trade/shared/package.json ./apps/trade/shared/
COPY apps/trade/server/package.json ./apps/trade/server/
COPY apps/trade/client/package.json ./apps/trade/client/
COPY apps/trade/worker/package.json ./apps/trade/worker/
COPY apps/acat/package.json ./apps/acat/

RUN npm ci --omit=dev --ignore-scripts --workspace=apps/trade/shared --workspace=apps/trade/server && \
    npm cache clean --force

FROM gcr.io/distroless/nodejs22-debian12@sha256:8a3e96fe3345b5d83ecec2066e7c498139a02a6d1214e4f6c39f9ce359f3f5bc AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/apps/trade/package.json ./apps/trade/
COPY --from=deps /app/apps/trade/shared/package.json ./apps/trade/shared/
COPY --from=deps /app/apps/trade/server/package.json ./apps/trade/server/
COPY --from=base /app/apps/trade/shared/dist ./apps/trade/shared/dist
COPY --from=base /app/apps/trade/server/dist ./apps/trade/server/dist
COPY --from=base /app/apps/trade/client/dist ./apps/trade/client/dist
# The synthetic universe the demo seed and the stand-ins read.
COPY synthetic/out/universe.json ./synthetic/out/universe.json

ENV NODE_ENV=production
ENV PORT=8080
ENV DEMO_UNIVERSE_PATH=/app/synthetic/out/universe.json
EXPOSE 8080

# Distroless includes UID/GID 65532; application files need read access only.
USER 65532:65532
# Exec form is required because distroless has no shell or curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "require('node:http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:'/api/health/live',timeout:3000},r=>process.exit(r.statusCode===200?0:1)).on('timeout',()=>process.exit(1)).on('error',()=>process.exit(1))"]

CMD ["apps/trade/server/dist/index.js"]
