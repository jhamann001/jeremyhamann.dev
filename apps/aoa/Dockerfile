# syntax=docker/dockerfile:1
# Multi-stage build for the AOA Next.js app (P1.2 / ticket).
# Next.js `output: "standalone"` (next.config.mjs) emits a self-contained server
# (.next/standalone/server.js + a trimmed node_modules); we copy that plus the
# static assets and public/ into a minimal, non-root runner. No secrets are baked
# into the image — all secret env is injected by Cloud Run from Secret Manager.

# ---------------------------------------------------------------------------
# Builder — install deps, generate the Prisma client, build the standalone app.
# ---------------------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Install exactly the locked deps first (better layer caching). Copy prisma/
# BEFORE `npm ci` so the package.json `postinstall` hook (`prisma generate`)
# finds prisma/schema.prisma — without it, `npm ci` fails with "Could not find
# Prisma Schema" (same ordering the migrate image already relies on).
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Bring in the rest of the source.
COPY . .

# Generate the Prisma client BEFORE the build so Next's file tracing includes the
# engine in .next/standalone/node_modules/.prisma.
RUN npx prisma generate

# Build the Next.js standalone output. auth.ts reads process.env at module load
# but the build does not evaluate real secrets (dev-fallback path), so no build
# secrets are required or provided here.
RUN npm run build

# ---------------------------------------------------------------------------
# Runner — minimal, non-root, runs the standalone server on the Cloud Run port.
# ---------------------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app

ARG AOA_SOURCE_COMMIT_SHA=unknown
ENV NODE_ENV=production
ENV AOA_SOURCE_COMMIT_SHA=${AOA_SOURCE_COMMIT_SHA}
LABEL org.opencontainers.image.revision=${AOA_SOURCE_COMMIT_SHA}
# Cloud Run sends traffic to $PORT; bind the standalone server to it on all ifaces.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# Copy the standalone server + assets, owned by the built-in non-root `node` user.
# .next/static and public/ are NOT part of standalone and must be copied explicitly.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# The standalone server is `node server.js`. npm's private node_modules still
# ship tar (CVE-2026-23950) and the Debian base can lag perl-base
# (CVE-2026-48962). Upgrade packages, then remove npm, before dropping
# privileges. `npm install -g tar` does not replace the nested copy.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Drop privileges.
USER node

EXPOSE 8080

CMD ["node", "server.js"]
