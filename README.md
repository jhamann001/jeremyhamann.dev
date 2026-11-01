# Portfolio

Jeremy Hamann's portfolio site and the demo apps it links to. Live at **jeremyhamann.dev**.

Every demo runs on one invented advisory firm, **Cedar Ridge Wealth**. Every person, household, account and account number in this repo is synthetic. The custodians are real: Apex is the clearing firm, and the Transfer Tracker's custodian library carries each delivering firm's real DTC number, requirements and published fees.

Live demos: **Trade Request** at [trade.jeremyhamann.dev](https://trade.jeremyhamann.dev), the **Transfer Tracker** at [transfers.jeremyhamann.dev](https://transfers.jeremyhamann.dev), the **WM Help Desk** at [helpdesk.jeremyhamann.dev](https://helpdesk.jeremyhamann.dev) and the **Statement Analyzer** at [statements.jeremyhamann.dev](https://statements.jeremyhamann.dev).

This public repository is a snapshot of the reviewed code, updated with each release. Day-to-day work, CI and deploys run in a private working repository, so the workflows here don't run.

## Layout

| Path | What it is |
|---|---|
| `site/` | The portfolio site (Astro, static) served by a small Cloudflare Worker that adds security headers |
| `synthetic/` | Generator for the shared synthetic universe used by every demo (`synthetic/out/universe.json`) |
| `apps/` | The demo apps, each served from a Cloudflare container. `apps/trade/` is Trade Request (React and Express on Postgres), `apps/acat/` is the Transfer Tracker and `apps/helpdesk/` is the WM Help Desk (both Next.js and Prisma on Postgres). The help desk installs on its own, outside the npm workspace (`cd apps/helpdesk && npm ci`). `apps/statements/` is the Statement Analyzer (Python and FastAPI on Postgres, with a React frontend in the workspace). `apps/demo-edge/` is code the demos' Workers share |
| `tools/guard/` | Checks that keep real names, real data and secrets out of the repo |
| `plans/` | Build plans |

## Guardrails

- **Real-name check.** A pre-commit hook and CI block any term on a private block list. The list is kept outside the repo, so the names it protects are never published. CI scans every file, every commit message and the full history on every push.
- **Commit emails.** CI fails if any commit in the history uses an email other than the private GitHub address. That includes merges GitHub makes itself, which skip local hooks.
- **Secret scan.** gitleaks runs in the pre-commit hook and over full history in CI.
- **Data files.** Spreadsheets, PDFs and database files are only allowed in `synthetic/out/`.
- **Deploys.** Nothing deploys on push. Each deploy runs from a button-press workflow on `main`, after the same checks pass.

## Commands

```bash
npm install                    # also installs the git hooks
npm run generate -w synthetic  # rebuild synthetic/out/universe.json
npm test                       # all workspace tests
npm run dev -w site            # site at http://localhost:4321
npm run build -w site
```
