# The Transfer Tracker demo image. Build it from the repository root, where the npm workspaces and the
# lockfile live:  docker build -f apps/acat/Dockerfile --platform linux/amd64 .
# Cloudflare Containers run it behind the Worker in apps/acat/worker (which builds it on deploy).
#
# node:22.23.4-alpine3.23 is the published base whose linux/amd64 child ships musl 1.2.5-r24. A later
# apk upgrade does not replace the package the image scan reads from the base layer.

FROM node:22.23.4-alpine3.23@sha256:6abbcf5dd6b231da109bcde1181db1d92bf78015ae1a9514d9807c1f857869db AS builder
# Build-only stage; no long-running process to probe.
HEALTHCHECK NONE
WORKDIR /app

# Every workspace's package.json, so npm ci can check the lockfile; only the tracker installs.
COPY package.json package-lock.json ./
COPY synthetic/package.json ./synthetic/
COPY site/package.json ./site/
COPY apps/trade/package.json ./apps/trade/
COPY apps/trade/shared/package.json ./apps/trade/shared/
COPY apps/trade/server/package.json ./apps/trade/server/
COPY apps/trade/client/package.json ./apps/trade/client/
COPY apps/trade/worker/package.json ./apps/trade/worker/
COPY apps/acat/package.json ./apps/acat/
COPY apps/acat/worker/package.json ./apps/acat/worker/

RUN npm ci --ignore-scripts --workspace=apps/acat

COPY apps/acat/ ./apps/acat/
# The synthetic universe the seed and the stand-ins read; the build traces it into the output.
COPY synthetic/out/universe.json ./synthetic/out/universe.json

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Read when the app is built, not when it runs: the demo screens, and the back link to the portfolio.
ENV NEXT_PUBLIC_DEMO_MODE=on
ARG NEXT_PUBLIC_PORTFOLIO_URL=https://jeremyhamann.dev
ENV NEXT_PUBLIC_PORTFOLIO_URL=$NEXT_PUBLIC_PORTFOLIO_URL

WORKDIR /app/apps/acat
RUN npx prisma generate && npm run build

FROM node:22.23.4-alpine3.23@sha256:6abbcf5dd6b231da109bcde1181db1d92bf78015ae1a9514d9807c1f857869db AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root runtime user, with stable ids.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Next's standalone output keeps the monorepo layout: the server at apps/acat/server.js, with the
# dependencies it traced (Prisma's engine among them) in node_modules at the root. Static assets and
# public files are copied beside it. Ownership is set at copy time, which keeps the layers small.
COPY --chown=nextjs:nodejs --from=builder /app/apps/acat/.next/standalone ./
COPY --chown=nextjs:nodejs --from=builder /app/apps/acat/.next/static ./apps/acat/.next/static
COPY --chown=nextjs:nodejs --from=builder /app/apps/acat/public ./apps/acat/public
COPY --chown=nextjs:nodejs --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=nextjs:nodejs --from=builder /app/synthetic/out/universe.json ./synthetic/out/universe.json

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DEMO_UNIVERSE_PATH=/app/synthetic/out/universe.json

# The public liveness endpoint: the Node process is listening. It does not report database state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "apps/acat/server.js"]
