# Architecture

The desk's design rests on fifteen invariants. Each is enforced in code or in the database, and each
has tests that prove it. The numbers (I1–I15) are referenced from comments throughout the code.

## Invariants

| # | Invariant | How it holds |
|---|---|---|
| I1 | Internal notes never leave the server through a client-facing path. | The client API reads comments only through the `ClientVisibleComment` view, which selects public comments and exposes no visibility or author column. It uses a separate Prisma client restricted to reads, and in production a database role that can select nothing else. The response type has no field that could hold a note, and a final check refuses any payload that leaks one. |
| I2 | Audit rows are never updated or deleted, and tampering is detectable. | Row and statement triggers on `AuditLog` refuse UPDATE, DELETE and TRUNCATE for every role. A `BEFORE INSERT` trigger hash-chains each row (`seq`, `prevHash`, `hash`) under an advisory lock. `verifyAuditChain` recomputes the chain and records its own result. |
| I3 | Every change, and every view of ticket content, is audited with actor and IP, and a failed audit write fails the request. | Every mutation runs in one transaction whose last step writes the audit rows. Reads that return ticket content record the view before returning it. |
| I4 | PII is redacted before it is stored, and raw PII never reaches the database or the ledger. | `sanitizePII` runs on every free-text field after validation and before any write. The audit writer sanitizes again, including the attacker-controlled user agent. |
| I5 | Access is checked on the server in every action, query and route. | Middleware is only a convenience. Every server action and route re-checks with pure helpers in `src/lib/rbac.ts`, and every denial is written as `AUTHZ_DENIED`. |
| I6 | Persona sign-in can't exist in production. | Three independent checks key on `APP_ENV=production`: the sign-in predicate, an assertion at module load and boot, and environment parsing. |
| I7 | Every public reply carries a firm-approved disclaimer, appended into the stored body. | The reply action refuses a missing disclaimer or acknowledgement. Disclaimer text is code, versioned in git. |
| I8 | Comments are immutable and tickets are never hard-deleted. | Database triggers on `Comment` and `Ticket`, a Prisma extension that refuses the same operations, and restricted foreign keys. A ticket that should never have existed is voided, with a recorded reason. |
| I9 | The audited IP comes from the trusted-proxy resolver, never from the request body. | `resolveClientIp` takes the address the outermost trusted proxy appended, validates it as an IP literal, and records `"unknown"` otherwise. |
| I10 | SLA status is computed, never stored; the policy that applied is snapshotted on the ticket. | Due times are stamped at creation and on priority change. `computeSlaStatus` is pure, and list filters use SQL predicates that agree with it. |
| I11 | Prefetches never create view rows; every render a person sees does. | Ticket links never prefetch, and the view recorder refuses prefetch requests. |
| I12 | Unknown groups are dropped, no groups means no access, and deactivation is immediate. | Group parsing keeps only the four known values, and every request re-checks that the user is active. |
| I13 | Every ticket field change is concurrency-checked; comment side effects are atomic. | Field changes update by version and refuse stale writes. A comment's ticket side effects are conditional updates in the same transaction. |
| I14 | No ticket text or PII appears in URLs, server logs, or unescaped CSV cells. | Prisma logs warnings and errors only, CSV cells are quoted and formula-guarded, and export audit rows are written before the file streams. |
| I15 | The hand-written enum mirrors equal the Prisma enums. | A compile-time parity check and a runtime test. |

## Access

| Group | Operations | Client Service | Advice | Audit log | Admin |
|---|---|---|---|---|---|
| `ops_team` | write | read | read | — | macros, users, held mail, SLA policy, webhooks, API tokens, suppression, capabilities |
| `client_services` | read | write | — | — | — |
| `advisors` | read | read | write | — | — |
| `compliance_officers` | read | read | read | view, export, verify | macros, held mail, capabilities |

A user's rights are the union of their groups. Compliance reads everything and writes no queue.
Supervisory review is open to compliance and to operations; voiding a ticket needs operations and
write access to its queue.

## The ledger

`AuditLog` is append-only at the database. Its triggers fire for every role, including the table's
owner, so even a mistake in the app can't rewrite history. In production the app connects as a role
that can only insert and select ledger rows; migrations run as the owner. Comments are immutable the
same way, and tickets can't be deleted.

## Redaction

Three kinds are redacted at the door: Social Security numbers, card numbers and account numbers. Card
and account numbers keep their last four digits. Bank routing numbers, dates of birth and licence or
passport numbers are deliberately kept, because the desk needs them for wires, distributions and
caller verification. A routing number is recognised by a nearby label or by its checksum together
with a label, so the account number beside it is still redacted. Redaction is a bounded pattern
matcher, and `docs/CONTROL_MAP.md` lists what it misses.

## Outbound

Email, Slack, web push, webhooks, the client API, the MCP endpoint and AI drafting are each off
unless their environment key is set ("fail-closed"). A key that is set but malformed is refused at
boot by name. Client email leaves through a transactional outbox: a reply queues a delivery in the
same transaction, and a separate sender leases it, sends it and marks it sent.
