// Case-study content for the four demos. `status` flips to 'live' as each demo ships, and a live demo
// gets screenshots: `hero` replaces the preview sketch, `gallery` adds an "In the app" section.

import { screen, type Screen } from './screens';

export type ProjectStatus = 'coming-soon' | 'live';

export interface Project {
  slug: string;
  name: string;
  kicker: string;
  color: string;
  icon: string;
  host: string;
  status: ProjectStatus;
  card: string;
  /** What the real system does in production today, shown on the home page card. */
  production?: string;
  summary: string;
  stack: string[];
  meta: [string, string][];
  problem: string;
  built: string[];
  decisions: [string, string][];
  arch: [string, string][];
  demo: string;
  hero?: Screen;
  gallery?: Screen[];
}

export const DOMAIN = 'jeremyhamann.dev';

export const projects: Project[] = [
  {
    slug: 'help-desk',
    name: 'WM Help Desk',
    kicker: 'Client service platform',
    color: 'var(--help)',
    icon: 'inbox',
    host: 'helpdesk',
    status: 'live',
    card: 'A multi-queue help desk with role-based access, PII redaction before storage, SLA clocks and a tamper-evident audit ledger.',
    summary:
      'A multi-queue help desk built for a registered investment adviser, with books-and-records controls designed in from the start: role-based access, PII redaction before anything is stored, SLA tracking and a hash-chained audit ledger.',
    stack: ['Next.js', 'TypeScript', 'Prisma', 'Postgres', 'Auth.js', 'Vitest'],
    meta: [
      ['Role', 'Design, engineering, rollout'],
      ['Users', 'Client service, operations, advisors, compliance'],
      ['Stack', 'Next.js · Prisma · Postgres'],
    ],
    problem:
      'Client service ran on a general-purpose ticketing tool. Internal notes and client replies sat side by side, account numbers and Social Security numbers landed in free text, and there was no way to show a reviewer that a record had not been changed after the fact.',
    built: [
      'Queues for operations, client service and advice, with read or write access set by group membership. Compliance reads every queue and changes no ticket.',
      'Internal notes in a separate visibility channel that client-facing views cannot query.',
      'PII redaction before the write, so the database never holds a full SSN or account number.',
      'Email intake that threads a client’s reply onto its ticket, checks the sender’s authentication and holds anything suspect for review.',
      'Approved macros for common replies, a firm-approved disclaimer appended to every client reply, and a queue where compliance reviews the replies sent.',
      'SLA clocks with On track, Warning and Breached states, and alerts before a breach.',
      'An append-only audit ledger in which every entry carries the hash of the one before it, and a check that re-verifies the whole chain on demand.',
      'A phone-first interface with a single layout breakpoint, since most triage happens away from a desk.',
    ],
    decisions: [
      ['Redact on the way in', 'Masking at display time still leaves raw values in backups and exports. Redacting before the write means there is nothing to leak.'],
      ['Enforce visibility where data is read', 'Client-facing reads go through a database view that holds no internal notes, so a new client-facing screen cannot expose one by accident.'],
      ['Hash-chain the audit log', 'Each row stores the previous row’s hash, and the database refuses to update or delete one. Re-verifying the chain proves no entry was edited or removed.'],
      ['Write the contract first', 'The architecture document sets 15 invariants, each enforced in code and checked by tests that run in CI, so a change that breaks one fails the build.'],
    ],
    arch: [
      ['Browser', 'phone · desktop'],
      ['Next.js app', 'RBAC · redaction · SLA'],
      ['Postgres', 'tickets · audit ledger'],
      ['Scheduler', 'SLA alerts'],
    ],
    demo: 'The demo runs the production app’s code on a fictional firm, with sign-in replaced by four staff personas: operations, client service, advisor and compliance. The mail sender and Slack are replaced by stand-ins inside the container, so every client email and SLA alert lands in an in-app Outbox instead of being sent, and two buttons there play the client, sending a new email or a reply through the app’s real email intake. AI drafts come from canned text, uploads are off (the seeded attachments still open), and webhooks, web push and the client API are switched off. The data resets daily at 14:00 UTC.',
    hero: screen(
      'help-dashboard',
      'The help desk dashboard: open tickets in the Operations, Client Service and Advice queues with counts of unassigned, warning and breached tickets, above a filterable ticket list sorted by SLA.',
    ),
    gallery: [
      screen(
        'help-ticket',
        'An urgent wire-transfer ticket past its SLA, showing the client’s request, a client-visible reply with its wire-verification disclaimer, and the ticket’s status, priority, assignee and queue.',
        'A ticket and its thread. Client replies and internal notes are kept apart, and every client reply carries its disclaimer.',
      ),
      screen(
        'help-outbox',
        'The Outbox: an email the desk sent to a client, and the SLA sweep’s Slack alert listing breached and warning tickets.',
        'The Outbox. Every client email and Slack alert the demo would have sent, with buttons that answer as the client.',
      ),
      screen(
        'help-audit',
        'The compliance audit log after a chain verification: every row re-hashes to its stored hash and links to the one before it, above a filterable list of sign-ins and views.',
        'The audit ledger. One click re-hashes the whole chain, and the check itself is recorded.',
      ),
      screen(
        'help-reviews',
        'The reply review queue: public replies from the last 30 days awaiting supervisory review, oldest first, each with its disclaimer and a Review button.',
        'Supervisory review. Client replies wait here, oldest first, until compliance reviews them.',
      ),
    ],
  },
  {
    slug: 'trade-request',
    name: 'Trade Request',
    kicker: 'Trading workflow',
    color: 'var(--trade)',
    icon: 'arrow-right-left',
    host: 'trade',
    status: 'live',
    card: 'An advisor-to-trader workflow with an asset-location engine, drift monitoring and a compliance record for every request.',
    production: 'used daily by a 4-person trading team, shipped through 126 production deploys.',
    summary:
      'Structured trade requests from advisors, a trader queue with a pre-approval checklist, an asset-location engine that turns each request into an execution plan, and a drift monitor that compares every account with its model portfolio.',
    stack: ['React', 'Vite', 'Express', 'Postgres', 'TypeScript', 'Zod'],
    meta: [
      ['Role', 'Design and engineering'],
      ['Users', 'Advisors and traders'],
      ['Stack', 'React · Express · Postgres'],
    ],
    problem:
      'Trade requests arrived by chat and email with missing details. Traders re-keyed them into spreadsheets, chased follow-up questions, and had no single record of who approved what and when.',
    built: [
      'A request form that adapts to the request type and will not submit an incomplete request.',
      'A searchable trading queue with the status, advisor and submitter of every request.',
      'A pre-approval checklist and an audit trail on every request, so each approval shows what was checked and who decided.',
      'An asset-location engine that places cash and fixed income in the account where each is taxed least.',
      'A drift monitor that compares every account with its model portfolio, can rank accounts by unrealized gain so the cheapest fixes come first, and lets a trader mark known exceptions.',
      'A compliance PDF for every request, and a firm-wide compliance report: what was asked, what was approved and by whom.',
      'Domain types shared between client and server, so a renamed field fails the build on both sides.',
    ],
    decisions: [
      ['Structured requests only', 'Free-text requests were the root problem. Each request type has its own required fields and validation.'],
      ['The engine is a pure function', 'Asset location takes holdings and a model and returns a plan. With no database access it is simple to test against fixtures.'],
      ['Approval before execution', 'Nothing is traded from a request directly. A trader approves a plan, and the approval is part of the record.'],
      ['One deployable unit', 'Express serves the built React app, which keeps hosting simple and inexpensive.'],
    ],
    arch: [
      ['Advisor / Trader', 'browser'],
      ['React SPA', 'forms · queue · plans'],
      ['Express API', 'engine · drift · PDF'],
      ['Postgres', 'requests · approvals'],
    ],
    demo: 'The demo runs the production app’s code on a fictional firm. The data warehouse, the model provider’s feeds and Slack are replaced by stand-ins that answer in their real formats inside the container, and every Slack message and email lands in an in-app Outbox instead of being sent. A nightly reset restores the data and replays two weeks of drift checks, so the history always looks current.',
    hero: screen(
      'trade-drift',
      'The drift monitor: 93 accounts compared with their model portfolios, with counts of accounts out of tolerance and uninvested, and a table of accounts ranked by how far they have drifted.',
    ),
    gallery: [
      screen(
        'trade-queue',
        'The trading queue: a searchable table of trade requests with household, trade type, date, advisor, submitter and status.',
        'The trader’s queue. Every request, searchable, with its status and who submitted it.',
      ),
      screen(
        'trade-request',
        'A rebalance request open for review, showing its status, the selected account, the client’s risk level and the allocation it sets, with Approve and Reject buttons.',
        'A request under review. The audit trail and the pre-approval checklist are a tab away, and approval is recorded with a note.',
      ),
      screen(
        'trade-outbox',
        'The Outbox: Slack messages the app would have sent, including the daily drift report and the morning digest of open requests.',
        'The Outbox. Every Slack message and email the demo would have sent, including the daily drift report.',
      ),
    ],
  },
  {
    slug: 'transfer-tracker',
    name: 'Transfer Tracker',
    kicker: 'Account transfers',
    color: 'var(--xfer)',
    icon: 'route',
    host: 'transfers',
    status: 'live',
    card: 'Tracks account transfers from request to settlement, reconciles every position, fills transfer forms from the record and keeps a playbook for each delivering firm.',
    production: 'the ops team’s system of record for 640+ transfers across 37 custodians.',
    summary:
      'End-to-end tracking for brokerage account transfers: every transfer’s status and history, a position-by-position reconciliation against the clearing firm’s report, transfer forms filled from the account record, a playbook and fee schedule for each delivering firm, and cycle-time analytics.',
    stack: ['Next.js', 'React', 'Prisma', 'Postgres', 'pdf-lib', 'Zod'],
    meta: [
      ['Role', 'Design and engineering'],
      ['Users', 'Transfer team, admins and advisors'],
      ['Stack', 'Next.js · Prisma · Postgres'],
    ],
    problem:
      'Transfers were tracked in a spreadsheet while the real status lived in each custodian’s portal. Rejections surfaced late, partial transfers left residual positions behind, and transfer fees were reimbursed late or not at all.',
    built: [
      'A records view of every transfer, grouped by status, with quick filters for each person’s queue, open issues and fees still to submit.',
      'A detail drawer for each transfer with its full history: who changed what, and when.',
      'Position-by-position reconciliation: the holdings expected from the client’s statement, matched against the clearing firm’s report of what arrived.',
      'Transfer forms filled from the account record as a PDF, chosen by the delivering firm’s rules and saved with the transfer.',
      'A playbook for each delivering firm: DTC number, signature and medallion requirements, contact method, fee schedule and processing time.',
      'Fees applied from the delivering firm’s schedule, and a log of the reimbursements requested.',
      'Analytics on cycle time, monthly volume and each firm’s performance, with residual-sweep monitoring and data-quality checks.',
      'A read-only advisor view of every transfer, without account numbers, fees or internal notes.',
    ],
    decisions: [
      ['Pick clients, never type them', 'Each transfer links to people in the firm’s client directory, so a misspelled name cannot split a client’s history or reach a form.'],
      ['Custodian rules are data', 'Requirements, contacts and fees live in records. Each fee notes the schedule it came from, and the original schedule stays on file.'],
      ['Generate forms, never retype', 'Form fields come from the account record, and the account title is confirmed against the clearing firm before a form is built.'],
      ['Archive, never delete', 'A deleted transfer is archived with a reason and can be restored, so its history survives a mistake.'],
    ],
    arch: [
      ['Transfer team', 'browser'],
      ['Next.js app', 'records · recon · forms'],
      ['Postgres', 'transfers · custodians · history'],
      ['Statement Analyzer', 'expected positions'],
    ],
    demo: 'The demo runs the production app’s code on a fictional firm, with sign-in replaced by three staff personas: transfers, admin and advisor. The fee store, the client directory, the statement pipeline and Slack are replaced by stand-ins that answer in their real formats inside the container, and every Slack message lands in an in-app Outbox instead of being sent. Uploads are off: the clearing firm’s report comes from a bundled sample, and seeded fee summaries can be opened. The custodian library is the production one: every delivering firm with its DTC number, requirements, notes and published fees. A nightly reset restores the data.',
    hero: screen(
      'xfer-dashboard',
      'The transfer operations dashboard: 124 transfers, 101 completed, 3 rejected and 17 active, with a chart of monthly transfer requests by workflow.',
    ),
    gallery: [
      screen(
        'xfer-records',
        'All records grouped by status, showing each transfer’s client, status, delivering firm, direction, advisor, control number, statement amount and days open.',
        'Every transfer, grouped by status. Quick filters cover each person’s queue, open issues and fees still to submit.',
      ),
      screen(
        'xfer-recon',
        'A completed transfer in the detail drawer: seven positions loaded from asset mapping, all seven matched to the clearing firm’s report, and a table of positions with their transfer eligibility and statement date.',
        'Reconciliation for one transfer. Positions expected from the statement are matched against what the clearing firm reports arriving.',
      ),
      screen(
        'xfer-custodian',
        'A delivering firm’s playbook: DTC number, transfer type, signature and medallion requirements, contact method, transfers to date and recent clients.',
        'A playbook for each delivering firm. Its fee schedule sits below, with the original schedule kept on file.',
      ),
      screen(
        'xfer-advisor',
        'The advisor view: active transfers with client, delivering firm, direction, value and status, one of them opened to show its dates and the firm’s expected processing time.',
        'The advisor view. Read-only, and without account numbers, fees or internal notes.',
      ),
    ],
  },
  {
    slug: 'statement-analyzer',
    name: 'Statement Analyzer',
    kicker: 'Document processing',
    color: 'var(--stmt)',
    icon: 'file-search',
    host: 'statements',
    status: 'live',
    card: 'Model-based extraction plus a tested 15-layer rule chain. Cut statement review from 30–45 minutes to under a minute.',
    production: '320+ statement files parsed for ~40 client households.',
    summary:
      'Extracts every account and position from a brokerage statement and decides what can transfer in kind. A language model reads the document; a tested, deterministic rule chain makes every decision.',
    stack: ['Python', 'FastAPI', 'Gemini', 'Postgres', 'React', 'fpdf2'],
    meta: [
      ['Role', 'Design and engineering'],
      ['Impact', 'Review time 30–45 min → under 60 s'],
      ['Stack', 'Python · FastAPI · React'],
    ],
    problem:
      'Before each transfer, someone read the client’s statements by hand to list every account and holding and spot anything that could not move. It took 30 to 45 minutes per client, and mistakes surfaced weeks later as rejected transfers.',
    built: [
      'A pre-check that turns away files that aren’t investment statements and flags any too old to rely on.',
      'Extraction of every account, position, quantity, value and cost basis into structured data, including statements that hold several accounts, or several registrations under one investor number.',
      'A 15-layer rule chain that routes each position: transfer in kind, sell first, move by ACH or wire, unsupported at the receiving firm, or needs review.',
      'A totals check: when the extracted positions don’t add up to the statement’s printed total, the whole account goes to review.',
      'A household view across every statement and run, with an Operations view for overrides, deletes and account-type changes, and a read-only Client Service view for advisors.',
      'Suggested accounts to open at the receiving firm, checked against each owner’s existing accounts.',
      'PDF and CSV exports, and a positions API the Transfer Tracker reads.',
    ],
    decisions: [
      ['The model only reads', 'The language model turns a PDF into data. Every decision comes from deterministic, tested rules, so a reviewer can see exactly why.'],
      ['Stop at the first rule that decides', 'Each position runs down the chain until one layer decides, and the screen shows which rule it was and why, so a wrong answer is quick to trace.'],
      ['Totals must reconcile', 'Extracted positions must add up to the statement total, or the whole account goes to review.'],
      ['Cache the expensive step', 'Extraction runs once per document. Changing an account’s type re-runs only the rules, with no model call.'],
    ],
    arch: [
      ['Drive folder', 'statement PDFs'],
      ['Extraction', 'LLM → JSON'],
      ['Rule chain', '15 layers · tested'],
      ['Household view', 'review · PDF'],
    ],
    demo: 'The demo runs the real app’s code, adapted for the demo, on a fictional firm, with sign-in replaced by two staff personas: a transfer specialist in the Operations view and an advisor in the read-only Client Service view. It never calls a model: each sample statement’s pre-screen and extraction answers are prepared from the statement itself, in the JSON the app’s prompts ask for, and the app’s own code does the rest live, from the asset types and transfer rules to the totals check and the write. Nine sample households (twelve statements) cover the cases the rules exist for, from a trust the receiving firm can’t take to a statement whose positions don’t add up. Runs start from a sample panel instead of a Drive folder, and the Slack scan summary and the reports saved to Drive land in an in-app Outbox. The scheduled scan, the machine APIs and the MCP server are switched off. The data resets daily at 07:00 UTC.',
    hero: screen(
      'stmt-household',
      'The Okafor household in the Operations view: three accounts from one Edward Jones statement, counts by status with ten positions eligible for ACAT and two for review, and the accounts to open at the receiving firm.',
    ),
    gallery: [
      screen(
        'stmt-rules',
        'A joint account’s positions with shares, value, cost basis and classification, the rule engine’s status for each, and the rule that decided it. A Bridge Builder mutual fund is held for review.',
        'Every position shows its status and the rule that decided it.',
      ),
      screen(
        'stmt-blocked',
        'A revocable trust’s statement: a hard-block banner says trusts aren’t supported at the receiving firm, and every position is marked unsupported with that rule as the reason.',
        'A trust the receiving firm can’t take. Every position is blocked, with the reason.',
      ),
      screen(
        'stmt-samples',
        'The sample statements panel during a run: a progress bar naming the current step, above the three chosen sample households and a note that the demo has no live model.',
        'The sample panel. A run takes about a minute, and the panel says plainly that the extraction is prepared.',
      ),
      screen(
        'stmt-advisor',
        'The advisor’s Client Service view of the same household: 88% of its value ready for ACAT transfer, the account ready to submit, and an action plan for the rest.',
        'The advisor’s read-only view, sorted for the client conversation.',
      ),
      screen(
        'stmt-outbox',
        'The Outbox: a household report saved to the client’s Drive folder and the Slack scan summary, both kept in the demo instead of sent.',
        'The Outbox. The Slack summaries and Drive saves the app would have sent.',
      ),
    ],
  },
];
