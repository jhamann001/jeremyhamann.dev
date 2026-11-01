# The Statement Analyzer demo image: the React app, built, served by the FastAPI service. Build it from the
# repository root, where the npm workspaces and the lockfile live:
#   docker build -f apps/statements/Dockerfile --platform linux/amd64 .

# Stage 1: build the frontend. Same pinned Node base as the Transfer Tracker's image.
FROM node:22.23.4-alpine3.23@sha256:6abbcf5dd6b231da109bcde1181db1d92bf78015ae1a9514d9807c1f857869db AS frontend
# Build-only stage; no long-running process to probe.
HEALTHCHECK NONE
WORKDIR /app

# The root manifest and lockfile, so npm ci can check the lockfile; only the frontend installs.
COPY package.json package-lock.json ./
COPY apps/statements/frontend/package.json ./apps/statements/frontend/
RUN npm ci --ignore-scripts --workspace=apps/statements/frontend

COPY apps/statements/frontend/ ./apps/statements/frontend/
# The demo links back to the portfolio site from its sign-in screen (PortfolioLink in src/App.jsx).
ARG VITE_PORTFOLIO_URL=https://jeremyhamann.dev
RUN npm run build --workspace=apps/statements/frontend

# Stage 2: the Python service. The base is pinned to a Python patch and a Debian codename, so a base move is a
# deliberate change rather than a surprise on the next build. Stay on 3.11, which CI tests.
FROM python:3.11.17-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY apps/statements/requirements.txt .
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --upgrade pip setuptools wheel \
 && pip install --no-cache-dir -r requirements.txt

# One line: test_holdings_transferability.py reads it to check every module the server imports, directly or not,
# is copied.
COPY apps/statements/account_resolution.py apps/statements/automation_pipeline.py apps/statements/auth.py apps/statements/custodian_library.py apps/statements/db.py apps/statements/demo.py apps/statements/demo_reset.py apps/statements/holdings_transferability.py apps/statements/mcp_server.py apps/statements/pdf_export.py apps/statements/reference_data.py apps/statements/samples.py apps/statements/server.py apps/statements/stand_ins.py ./
# The receiving custodian's rules, which the demo reads in place of a Notion database (stand_ins.py).
COPY apps/statements/apex_rules.csv ./
# The shared synthetic universe the nightly reset seeds from (demo_reset.py).
COPY synthetic/out/universe.json ./universe.json
ENV DEMO_UNIVERSE_PATH=/app/universe.json
COPY --from=frontend /app/apps/statements/frontend/dist ./static

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV PORT=8080

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT} --timeout-keep-alive 600"]
