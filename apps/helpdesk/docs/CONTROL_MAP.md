# Control map — WM Help Desk

**Status:** describes the code in this repository. Nothing in this document is a legal opinion, and nothing here is a
representation that the firm's programme is adequate — that judgement is the CCO's and is the subject
of the 206(4)-7 annual review, not of this file.

**What this file is for.** When an examiner, an auditor or the CCO asks "how do you know?", the answer
has to name a control, say what kind of control it is, and point at the artefact. This is that list.
It is two pages on purpose: a control map nobody re-reads is a control map nobody maintains.

## The three words, and why the distinction matters

| Word | Means | What a failure looks like |
|---|---|---|
| **Enforced** | The system refuses the wrong outcome. A person cannot do the thing, whatever they intend, and there is no "are you sure" that lets them through. | A bug. Reproducible, fixable, and provable by a test. |
| **Evidenced** | The system permits the act and records it, permanently and attributably. The control is the record, not the refusal. | A gap in the ledger. Detectable by reconciliation. |
| **Procedural** | A person is expected to do something. The system may prompt, structure or remind; it does not compel. | A training or supervision finding. Not visible in code. |

Calling a procedural control "enforced" is the single most expensive error in a control map, because
it is discovered during an examination rather than during a review. Where this file says
**procedural**, it means the firm is relying on a person.

---

# Page 1 — Books and records, and supervision

## Advisers Act Rule 204-2 — books and records

204-2(a)(7) requires originals of written communications received and copies of written communications
sent relating to (i) recommendations or advice, (ii) receipt, disbursement or delivery of funds or
securities, and (iii) the placing or execution of orders. 204-2(e) sets the retention period (five
years, first two in an easily accessible place) and 204-2(g) governs electronic records: they must be
arranged for ready access, reasonably safeguarded from loss, alteration and destruction, and limited
to authorised personnel.

| # | Control | Kind | Where it lives | The artefact |
|---|---|---|---|---|
| 1 | A comment is never edited or deleted. UPDATE/DELETE/TRUNCATE triggers on `"Comment"`, plus a Prisma-extension refusal, plus `onDelete: Restrict` on every FK. | **Enforced** (database) | I8; `prisma/migrations/**`, `src/lib/db.ts` | `npm test -- db db.integration` |
| 2 | A ticket is never hard-deleted. Same triggers on `"Ticket"`. A ticket that should never have existed is `VOIDED` — a status, with a recorded reason ≥ 12 characters, refused once any PUBLIC reply exists. | **Enforced** | I8, Decision #96; `voidTicket` (B2) | `npm test -- db`, the `VOIDED` seed fixture |
| 3 | A public reply's stored body is exactly what the client received, disclaimer included. | **Enforced** | I7; `addPublicReply` | `npm test -- validation disclaimers` |
| 4 | A withdrawn reply is overlaid, never erased. `CommentRetraction` is append-only; the client view blanks the body **at the database**, and the staff surface still shows what was sent. | **Enforced** | Decision #101, CONTRACT §1.6; guardrail **G16** | `npm test -- guardrails` |
| 5 | Every mutation and every view of ticket content writes an audit row in the same transaction; a failed audit insert rolls the business write back and serves nothing. | **Enforced** | I3; `withTx` + `writeAuditMany` last, `recordView` awaited | `npm test -- guardrails audit` |
| 6 | The ledger is append-only and tamper-evident: triggers for every role, a per-row hash chain under an advisory lock, and `verifyAuditChain` which records its own result. | **Enforced** (database) | I2 | `npm test -- db.integration`; the Verify chain button |
| 7 | Reading the record is itself a record. Ticket detail, preview, attachment download, the client API, the audit log and every CSV export write their own row **before** content is produced. | **Evidenced** | I3, I14; `recordView`, `recordMaterialRead`, the pre-stream export rows | `npm test -- audit-export guardrails` |
| 8 | Retention. The database retains everything the rules require and deletes nothing; there is no purge job for tickets, comments, audit rows or notifications. | **Procedural** | CONTRACT §14 — `Notification` has no retention job, by decision, not by oversight | The retention schedule, which is the CCO's document and not this repository's |
| 9 | Ready access for an examiner: the audit CSV carries `seq`, `prevHash` and `hash`, so the chain can be re-verified offline from the file alone. | **Evidenced** | `src/server/audit-export.ts` | An exported file |

**Residual, stated rather than hidden.** 204-2 obliges the FIRM, and this system holds only the
correspondence that passed through it. A reply typed into a personal mail client is outside every
control on this page. That is a procedural boundary, and the mitigation is mailbox routing and staff procedure, not code.

## Advisers Act Rule 206(4)-7 — compliance programme

The rule requires written policies reasonably designed to prevent violation, an annual review of their
adequacy and of the effectiveness of their implementation, and a designated CCO. For a desk whose
output is written correspondence, the operative control is somebody other than the author reading what
went out — and that is the control Wave B adds.

| # | Control | Kind | Where it lives | The artefact |
|---|---|---|---|---|
| 10 | **Supervisory review of outbound replies.** `ReviewStamp` names a reviewer, a verdict (`APPROVED` / `FLAGGED`), the points they checked and an optional note. Append-only, unique per (comment, reviewer). | **Evidenced** | `src/server/reviews.actions.ts`, `stampReview` | `REVIEW_STAMPED` rows; `/compliance/reviews` and its CSV |
| 11 | **That every reply IS reviewed** is not enforced. The queue at `/compliance/reviews` lists what is waiting, oldest first; nothing blocks a reply, and nothing blocks a ticket closing unreviewed. | **Procedural** | CONTRACT §5 — a stamp touches no ticket field and no client record | The queue's own count, and the CSV's `stamped` column |
| 12 | The review checklist is code, not configuration: five fixed points, changed by a reviewed commit. | **Enforced** (as a vocabulary) | Decisions #7, #73; `src/lib/review-checklist.ts` | `npm test -- review-checklist` |
| 13 | A reviewer cannot quietly change their mind: a second stamp by the same reviewer is refused (`CONFLICT`), a second reviewer may add a second opinion. | **Enforced** | `@@unique([commentId, reviewerId])` | `npm test -- compliance.integration` |
| 14 | Reading a reply in full before stamping it is recorded (`TICKET_PREVIEWED`), so "did the reviewer read what they signed off" is answerable. | **Evidenced** | `openReplyForReview` | The ledger, filtered by actor |
| 15 | **Identity verification before a money-movement ticket may be called finished.** The five `MONEY_MOVEMENT_CATEGORIES` cannot reach `RESOLVED` without a `VERIFIED` (or `OVERRIDDEN`) `IdentityVerification` row. | **Enforced** | Decision #103; `assertIdentityGate`, called inside `changeTicketStatus`'s transaction | `npm test -- compliance.integration` |
| 16 | The exception to #15 is a positive fact, not an absence: an `ops_team` override writes `IDENTITY_GATE_OVERRIDDEN` **and** an `IdentityVerification` row with result `OVERRIDDEN`, with a reason ≥ 12 characters. | **Evidenced** | `overrideIdentityGate` | Filter the ledger on `IDENTITY_GATE_OVERRIDDEN`; filter the table on `result = 'OVERRIDDEN'` |
| 17 | **Whether the verification was any good** — whether the callback really went to the number on file — is a person's judgement. The system records the method and the reviewer's sentence; it verifies nothing itself. | **Procedural** | `IdentityVerificationMethod`, the note | The record, read by a supervisor |
| 18 | Separation of duties on the gate: recording is queue WRITE (`identity:verify`); overriding needs `ops_team` **as well**. Compliance holds no WRITE anywhere and therefore records neither. | **Enforced** | CONTRACT §5, §b rule 2 | `npm test -- rbac compliance.integration` |
| 19 | Complaints are a structured flag with its own stamped date, not a label somebody types. | **Evidenced** | Decision #64; `Ticket.isComplaint` / `complaintFiledAt` | The ledger, the CSV export |
| 20 | The annual review itself — reading the queue, sampling, concluding. | **Procedural** | — | The CCO's review memo |

---

# Page 2 — Reg S-P safeguards, access, and what is NOT claimed

## Regulation S-P — the safeguards rule (17 CFR 248.30) and the disposal rule

The safeguards rule requires written policies and procedures addressing administrative, technical and
physical safeguards for customer records and information, reasonably designed to ensure security and
confidentiality, protect against anticipated threats, and protect against unauthorised access or use
that could result in substantial harm. The 2024 amendments add an incident-response programme with
customer notification. **The incident-response programme is a firm document, not a system control, and
nothing in this repository satisfies it.**

| # | Control | Kind | Where it lives | The artefact |
|---|---|---|---|---|
| 21 | **Minimisation at write time.** Free text is redacted before it reaches the database: **Social Security, payment card and account numbers — three kinds** (Decision #116, 2026-09-20). Context-gated, idempotent. Bank **routing** numbers, dates of birth, US driver licence and passport numbers are **deliberately not redacted**: a routing number identifies a bank and is published, and the account number beside it still redacts, so the pair is still broken — including when a client writes the account number into the routing field, because the suppression applies only to a run of **exactly nine digits**, which is what an ABA number is. Two guards recognise a routing number: an adjacent `routing`/`aba`/`rtn`/`transit number` marker, and (2026-09-20 amendment) the ABA structure itself — nine digits, a valid Federal Reserve prefix and the 3-7-1 checksum — **together with** a marker anywhere in the 48 characters before, which is what makes `Routing / Account: X / Y` keep its ABA number. Structure alone never suppresses: 3.8% of random nine-digit runs pass it, so an unlabelled one still redacts. the other three were a Wave B addition the desk reversed because a date of birth is working data here. Already-redacted rows are not backfilled. | **Enforced** | I4, §f, Decision #116; `src/lib/pii.ts` | `npm test -- pii`; the §f vectors, including the six re-expected routing ones |
| 22 | The ledger is redacted too: `oldValue`, `newValue`, stringified `metadata` and the attacker-controlled `userAgent` all pass through `sanitizePII`, and `PII_REDACTED` rows carry counts only. **What that now means, stated plainly:** `oldValue`/`newValue` carry the FULL subject, description and comment-body text of every change, the audit CSV carries both columns, and `duplicate-copy` streams that CSV nightly to WORM storage under a 17a-4 retention lock. Since Decision #116 "redacted" means three kinds, so a routing number, date of birth, passport or licence number in a ticket is retained there **permanently and unpurgeably** — the ledger is append-only with no post-hoc redaction path. Accepted consequence of #116, not a defect. | **Enforced** | I4, Decision #116; `src/lib/audit.ts`, `src/jobs/duplicate-copy.ts` | `npm test -- audit` |
| 23 | **What redaction does NOT do.** It is a bounded pattern matcher, not a classifier. It will miss an unlabelled account number, a foreign identifier and anything written in prose ("the last four of her card are one one one one"). It over-redacts an **unlabelled** nine-digit run sitting within 24 characters of account context **as ACCOUNT** — `account 987654321 sent via 021000021` and `Chase checking 021000021 4455667788` both redact both runs, because neither sentence claims a routing number anywhere and redacting both is the safe reading — so the operator cannot tell from the token which half was masked. A **labelled** routing number is recognised (both guards, since the 2026-09-20 amendment) unless its marker sits more than 48 characters before the digits. It does not look for a date of birth, passport or licence number at all — though an **ISO** (`1975-01-02`) or **compact** (`19750102`) date near account context is still caught by the account rule and masked as ACCOUNT. The control for those three kinds is procedural in two places: the identity-verification sheet's instruction to record *what was checked* rather than the identifier, and the `NO_UNREDACTED_PII` item on the supervisory review checklist. | **Procedural** | §f "Residual risks"; `src/lib/pii.ts` module docstring; `src/lib/review-checklist.ts` | Stated to an examiner, not concealed |
| 24 | **Least privilege at the database.** The client-API role holds SELECT on ten `Ticket` columns and on the two client-visible views (`ClientVisibleComment`, `ClientVisibleOpeningMessage`), and on nothing else. Each view carries its disclosure rule as its own `WHERE`, so an internal note and a desk-composed opening message are unreachable rather than unrendered. All thirteen Wave B tables are explicitly REVOKEd. | **Enforced** (database) | I1, CONTRACT §1.5, Decisions #101/#117; guardrails **G15**, **G16**, **G17** | `npm test -- guardrails`; `TEST_DATABASE_URL=… npm test -- guardrails.integration` (refuses `Ticket.description` AS the role); `prisma/sql/runtime-roles.sql` |
| 25 | **Internal notes are unreachable, not merely unrendered**, on every client path — along with held intake, deliveries, attachments, drafts, notifications, review stamps and identity records. | **Enforced** | I1; `src/server/client-view.ts`, `publicDb`, guardrail **G8** | `npm test -- client-view client-view.integration` |
| 26 | Authorisation is server-side everywhere; middleware is a coarse UX gate only, and every denial is written as `AUTHZ_DENIED` before the refusal is returned. | **Enforced** + **Evidenced** | I5; `runAction`, every `route.ts` | `npm test -- rbac guardrails` |
| 27 | Group membership comes from Okta, unknown values are dropped, zero groups means no access, and a deactivated user's still-valid JWT is inert from the next request. **Second, optional source:** a domain-restricted Google sign-in grants the groups named in `AUTH_GOOGLE_GROUPS` — a static list attached to a DOMAIN rather than to a person, empty by default (so the default outcome is `/no-access`), and never permitted to be production's only sign-in method. Everything else in this row holds for it unchanged: unknown values drop, zero groups means no access, and the groups come from the sign-in and never from the stored `User.groups` snapshot (Decision #51). | **Enforced** | I12; `parseGroups`, `getViewer`, `googleGroups` | `npm test -- rbac`; `npm test -- google-domain auth` |
| 28 | **Stale authority is bounded twice.** An absolute 8-hour session lifetime bounds how long a demoted user keeps stale groups; a 30-minute idle timeout bounds how long an unattended machine stays signed in. A token with an unreadable stamp is expired (fail closed). | **Enforced** | Decision #105; `src/lib/session-policy.ts`, `auth.config.ts` | `npm test -- session-policy auth.config` |
| 29 | **The firm stores no third-party credential.** `withoutOidcTokens` nulls `access_token`, `refresh_token` and `id_token` on `linkAccount`; link metadata is kept, the bearer is not. One fewer thing a database compromise yields, one fewer thing in every backup, one fewer line in the Reg S-P data inventory. | **Enforced** | Decision #106; `src/lib/auth-adapter.ts` | `npm test -- auth-adapter` |
| 30 | **No client identifier in a URL.** The requester link uses the opaque advisor platform person pointer, never the email address, because the hosting platform records query strings verbatim and the browser keeps them in history. | **Enforced** in code; **procedural** at the edge | I14 as amended 2026-09-19 | `npm test -- requester-link-privacy` — **and an edge action: a log exclusion for the `requesterEmail` parameter, which the export route still accepts** |
| 31 | No client body, comment body or PII in a log line, a URL or an unescaped CSV cell. `csvCell` applies RFC 4180 quoting plus a formula-injection guard. Prisma logging is `warn`/`error` only. | **Enforced** | I14 | `npm test -- audit-export guardrails` |
| 32 | **Outbound payloads are PII-light by construction**: ids, numbers, enum values, counts and a deep link — never a subject, a requester name, an address or body text. `Notification.preview` is CHECK-bounded to 200 characters. | **Enforced** (database CHECK + code) | CONTRACT §7.3 | The schema; `npm test -- guardrails` |
| 33 | **Nothing transmits.** Every outbound path — Slack, email, webhooks, push — is disabled unless its env key is set, and message wording needs the firm's approval before a key is set. | **Enforced** (fail-closed env) + **procedural** (the approval) | CONTRACT §0.4, §4 | `npm test -- env`; the empty key set |
| 34 | Secrets are stored as `sha256` + a display prefix, returned in plaintext exactly once, verified in constant time, and never written to a route, a DTO, a log or an audit row. | **Enforced** | CONTRACT §7.2 | `npm test -- api-tokens` |
| 35 | Disposal (Reg S-P 248.30(b)): consumer-report information is not collected by this system, and nothing is disposed of by it. | **Procedural** | — | The firm's disposal policy |
| 36 | Encryption at rest and in transit, network placement, backup handling, vulnerability management. | **Procedural** (infrastructure) | Infrastructure configuration, outside this repository | Cloud provider configuration, not this table |
| 37 | Incident response and customer notification under the 2024 amendments. | **Procedural** | — | The firm's incident-response plan |

## What this system does NOT control

Written down because an unclaimed control is safer than an overclaimed one.

1. **It does not move money, and it does not authorise anybody who does.** The identity gate governs
   whether a TICKET may be marked resolved. The custodian's own controls govern the transfer.
2. **It does not supervise anything outside it.** A phone call is in the record only if somebody
   records it (`recordClientContact`); an email sent from a personal client is outside every control here.
3. **It does not verify identity.** It structures and records what a person did.
4. **It does not classify data.** Redaction is pattern matching with a stated residual.
5. **It does not enforce that any review happens** — only that a review, once made, is permanent,
   attributable and countable.
6. **It has no retention or disposal job.** It keeps everything and deletes nothing.

## Where to look, by question

| Question | Read |
|---|---|
| Who changed this ticket, and from what IP? | `/compliance/audit`, filtered by ticket |
| Was this reply supervised, by whom, with what verdict? | `/compliance/reviews`, `state=ALL`, or its CSV |
| Which wires closed without a verification? | The ledger, `IDENTITY_GATE_OVERRIDDEN`; or `IdentityVerification` where `result = 'OVERRIDDEN'` |
| Has the ledger been tampered with? | The Verify chain control, or re-run the chain offline from an exported CSV |
| What did we redact, and how much? | `PII_REDACTED` rows — three counters since Decision #116; rows written earlier carry the four-counter and seven-counter shapes and are never rewritten — and the `PiiIndicator` count on the record |
| Which features are switched on in this deployment? | `/admin/flags` — names only, never values |

---

**Maintenance.** This file is not generated. When a control changes, the commit that changes it
changes this table in the same commit, or the map is fiction. The rows that are hardest to keep honest
are the **procedural** ones, because nothing fails when they rot — which is precisely why they are
labelled.
