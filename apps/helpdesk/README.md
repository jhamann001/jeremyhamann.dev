# WM Help Desk

A multi-queue help desk for a registered investment adviser, built with books-and-records controls
from the first commit: group-based access, internal notes that no client-facing path can reach, PII
redaction before anything is stored, SLA clocks, supervisory review of client replies, and an
append-only, hash-chained audit ledger enforced by the database.

This copy runs on synthetic data for a fictional firm, Cedar Ridge Wealth, and its digital brand,
Cedar Ridge Direct. Every person, account and message in it is invented.

## What it does

- **Three queues** (Operations, Client Service, Advice) with access set by group membership. A
  group either writes a queue, reads it, or can't see it.
- **Tickets from every channel the desk works:** a staff form, email, a client app, phone and
  voicemail. Intake threads replies by a signed reply token, checks sender authentication, and holds
  anything it can't trust in a held-mail queue for a person to release or discard.
- **Two channels on every ticket:** internal notes and public replies. A public reply carries a
  firm-approved disclaimer appended into the stored body, so the record is exactly what the client
  received.
- **Redaction at the door:** Social Security, card and account numbers are replaced before a write,
  keeping the last four digits of cards and accounts. The ledger is redacted the same way.
- **SLA clocks** per priority, computed rather than stored, with warning and breach states, a sweep
  job, and reports on attainment.
- **Supervisory review:** a reviewer stamps each public reply approved or flagged; stamps are
  append-only.
- **Identity gate:** a money-movement ticket can't be resolved without a recorded identity
  verification, or an explicit, audited override.
- **The audit ledger:** every change and every view of ticket content writes a row in the same
  transaction. Rows are hash-chained by a database trigger, and the database refuses updates,
  deletes and truncation. A "Verify chain" control re-checks the chain on demand.
- **Mobile first:** phones (360–430 px) are the primary layout, with one switch to the desktop
  layout at 768 px.

## Where to read more

| Document | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The fifteen invariants, the access matrix, the ledger and redaction designs |
| [`docs/CONTROL_MAP.md`](docs/CONTROL_MAP.md) | Each control mapped to SEC Rule 204-2, 206(4)-7 and Reg S-P, and whether it is enforced, evidenced or procedural |
| [`docs/MOBILE_FIRST.md`](docs/MOBILE_FIRST.md) | The phone layout contract and its QA probes |
| [`docs/HISTORY.md`](docs/HISTORY.md) | Why some comments mention a "Decision #" or a "CONTRACT §" |

## Stack

Next.js 15.5 (App Router, server components and server actions) · TypeScript · Tailwind v4 and
shadcn · Prisma 6 on PostgreSQL 16 · Auth.js v5 · zod 4 · TanStack Table and Query · Vitest.

## Code layout

| Path | Contents |
|---|---|
| `src/app/` | Routes: the staff app, the client API, intake and outbox endpoints, health |
| `src/server/` | Server-side domain logic and server actions, each re-checking access |
| `src/lib/` | Pure helpers: access rules, SLA, redaction, audit writer, email parsing, environment |
| `src/jobs/` | Scheduled jobs: SLA sweep, alerts, follow-up nudges, auto-close, digests, duplicate copy |
| `src/components/` | UI, built on shadcn primitives |
| `prisma/` | Schema, migrations (including the ledger triggers), database roles, seeds |

## Running it locally

Needs Node 24 and PostgreSQL 16.

```bash
createdb helpdesk_dev
createdb wm_helpdesk_test        # database tests only; their rows are permanent by design
cp .env.example .env             # set AUTH_SECRET, AUTH_DEV_LOGIN=true, SEED_DEV_FIXTURES=true
npm run db:deploy
SEED_DEV_FIXTURES=true npm run db:seed
npm run dev -- -p 3100
```

Sign in at `http://localhost:3100/sign-in` with a demo persona. Persona sign-in is refused wherever
`APP_ENV=production`.

Every outbound feature (email, Slack, web push, webhooks, the client API, the MCP endpoint, AI
drafting) is off unless its environment key is set, and a key that is set but malformed stops the
app at boot. `.env.example` lists them all.

## Tests

```bash
npm run typecheck && npm run lint && npm test
TEST_DATABASE_URL=postgresql://…/wm_helpdesk_test npm test   # adds the database tests
```
