# syntax=docker/dockerfile:1
# The WM Help Desk demo image (helpdesk.jeremyhamann.dev). Build it from the repository root, which holds the
# synthetic universe the sample emails and the seeded attachments are made from:
#
#   docker build -f apps/helpdesk/Dockerfile --platform linux/amd64 .
#
# Cloudflare Containers run it behind the Worker in apps/helpdesk/worker, which builds it on deploy. The help desk
# installs on its own (its own lockfile, outside the npm workspace), so only apps/helpdesk is installed here.
#
# Two stages. Next.js `output: "standalone"` (next.config.ts) emits a self-contained server; the runner copies
# that plus the static assets, public/, the universe file and the seeded attachments into a minimal, non-root
# image. NO secret is baked in and none is needed to build (the `next build` worker skips the serving-process
# env invariants, Decision #43); the repository's .dockerignore keeps every .env* out of the context. All
# runtime settings come from the Worker when the container starts.

# ---------------------------------------------------------------------------
# Builder — install the locked deps, generate the Prisma client, build the standalone app.
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder
WORKDIR /app/apps/helpdesk

# Manifest + prisma/ BEFORE `npm ci` (better layer caching; @prisma/client's postinstall runs `prisma generate`).
COPY apps/helpdesk/package.json apps/helpdesk/package-lock.json ./
COPY apps/helpdesk/prisma ./prisma
RUN npm ci

COPY apps/helpdesk/ ./
COPY synthetic/out/universe.json /app/synthetic/out/universe.json

# Generate BEFORE the build so Next's file tracing carries the engine into .next/standalone/node_modules/.prisma.
RUN npx prisma generate

ENV NEXT_TELEMETRY_DISABLED=1
# Read when the app is built, not only when it runs: the demo screens, and the back link to the portfolio.
ENV NEXT_PUBLIC_DEMO_MODE=on
ARG NEXT_PUBLIC_PORTFOLIO_URL=https://jeremyhamann.dev
ENV NEXT_PUBLIC_PORTFOLIO_URL=$NEXT_PUBLIC_PORTFOLIO_URL
RUN npm run build

# The seeded attachments at the filesystem store's paths: byte for byte what the reset stamps on the rows.
RUN DEMO_UNIVERSE_PATH=/app/synthetic/out/universe.json npx tsx scripts/demo-attachments.ts .local-attachments

# ---------------------------------------------------------------------------
# Runner — minimal and non-root.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DEMO_UNIVERSE_PATH=/app/synthetic/out/universe.json

# .next/static and public/ are NOT part of the standalone output and must be copied explicitly.
COPY --from=builder --chown=node:node /app/apps/helpdesk/public ./public
COPY --from=builder --chown=node:node /app/apps/helpdesk/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/helpdesk/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/apps/helpdesk/.local-attachments ./.local-attachments
COPY --from=builder --chown=node:node /app/synthetic/out/universe.json ./synthetic/out/universe.json

# npm's private node_modules still ship vulnerable packages, and the Debian base can lag its security fixes.
# Upgrade packages, then remove npm, before dropping privileges.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node

EXPOSE 3000

# A TCP connect to the port the standalone server binds: the process is alive and listening. Deliberately not
# /api/health, which queries the database; the Worker's start check calls that one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('net').connect(Number(process.env.PORT||3000),'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

CMD ["node", "server.js"]
