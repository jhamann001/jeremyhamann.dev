// Case-study content for the five demos. `status` flips to 'live' as each demo ships, and a live demo
// gets screenshots: `hero` replaces the preview sketch, `gallery` adds an "In the app" section. The lead
// project (`lead`) gets the full-width card and opens its case study with its build numbers; the apps that
// also run inside it (`inside`) say so on their cards.

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
  /** The lead project: the full-width card at the top, with the apps that feed into it. */
  lead?: boolean;
  /** Counted from the production repository, shown first in the case study. */
  numbers?: [string, string][];
  /** The lead project's slug, for an app that also runs inside it. */
  inside?: string;
  /** How the production app protects data in transit and at rest, and what the demo keeps. */
  security?: string;
}

export const DOMAIN = 'jeremyhamann.dev';

export const projects: Project[] = [
  {
    slug: 'always-on-advice',
    name: 'Always-On-Advice',
    kicker: 'Advisor platform',
    color: 'var(--advice)',
    icon: 'layout-dashboard',
    host: 'aoa',
    status: 'live',
    lead: true,
    card: 'The firm handles its client work here, from the deal to the funded account. That covers households, account transfers, the ACAT book, statement-based asset mapping, trade requests and closeout, with row-level security for each role. Three of the apps below run inside it.',
    production: 'the firm’s operations platform since July 1, with 360 production deploys and 1,146 merged pull requests in four months.',
    summary:
      'This platform brings an advisory firm’s client work into one place. It covers households and deals, account transfers from the client’s statement to funded accounts, the ACAT book, statement-based asset mapping, trade requests and the closeout checklist, and each role sees only what it should. The Transfer Tracker, the Statement Analyzer and Trade Request feed into it.',
    stack: ['Next.js', 'TypeScript', 'Prisma', 'Postgres', 'Auth.js', 'Terraform'],
    meta: [
      ['Role', 'Design, engineering, rollout'],
      ['Users', 'Advisors, client service, operations, admins'],
      ['Stack', 'Next.js · Prisma · Postgres · Google Cloud'],
    ],
    numbers: [
      ['Four months', 'June 29 to October 29, 2026'],
      ['1,146', 'merged pull requests, 1,087 of them mine'],
      ['360', 'production deploys, plus 671 to dev and 2,500+ green CI runs'],
      ['137', 'database migrations behind 77 models, 5 schemas, about 350 row-level-security policies and 45 triggers'],
      ['62 pages', '88 API routes and about 180,000 lines of TypeScript'],
      ['918', 'test files, about 170,000 lines, and 64 browser specs'],
    ],
    problem:
      'What we knew about a household was spread across the CRM, a transfer spreadsheet, the custodian’s portal, chat threads and a handful of single-purpose tools. Nobody could follow one client from the signed deal to the funded account in one place, and each hand-off between tools was a chance to lose a detail.',
    built: [
      'A household and client directory sits on top of the CRM’s records, and each client’s accounts, AUM, beneficiaries and held-away accounts appear on one Client Portrait.',
      'A funding pipeline of deals opens the account transfer when a deal commits, so a transfer starts from the sale instead of a re-keyed form.',
      'Asset Transfer is a board that runs from decision to funded. Each transfer gets a funding plan built from the client’s statement, gates hold it until its checklist and paperwork are done, and it’s archived instead of deleted.',
      'The ACAT book is read live from the Transfer Tracker, with its fees and position reconciliation. The custodian library goes the other way, since this platform owns it and pushes it to the tracker.',
      'Asset Mapping brings in the Statement Analyzer’s results for each household, which are reviewed here and linked to the client and transfer they belong to.',
      'Trade Requests are built into the platform, including the queue, approvals and audit trail. Each client’s risk score and instructions are drawn from approved requests.',
      'While a transfer is in flight, a closeout checklist runs in Slack and its status comes back to the transfer.',
      'The platform also has Command Center, search across the whole app, a central review queue, data-health checks, and an audit log of business events and every field change on deals and transfers.',
    ],
    decisions: [
      ['Row-level security, not screen checks', 'Every query runs as a database role with the user’s role and book set on the connection, so a new screen can’t show an advisor another advisor’s client. There are about 350 policies, with tests that read the data as each role.'],
      ['Read the other apps, don’t copy them', 'The ACAT book comes from the Transfer Tracker when it’s viewed, and only the links between records are stored here, so each fact has one system that owns it.'],
      ['Audit in two layers', 'The app records each business event, and database triggers record every field change on deals and transfers, so the trail doesn’t depend on remembering to log.'],
      ['Move the backend last', 'Trade Requests’ screens are native here, its records have been copied into this database, and there’s a backend that can serve them. In production that backend is still switched off, so the standalone service answers. The demo runs with it switched on.'],
    ],
    security:
      'Every response is served over HTTPS with HSTS and a strict Content Security Policy. The app reaches its Postgres database over a private network, the database refuses any connection that isn’t encrypted, and Google Cloud encrypts the data and its backups at rest. Services sign in to each other with short-lived Google identity tokens, deploys use keyless workload identity, and secrets stay in Secret Manager rather than the code. Sensitive fields aren’t encrypted one by one; instead, row-level security in the database decides who can read them, internal client ids are withheld from everyone but operations and admins, and account numbers show only their last four digits. The demo keeps the same headers, row-level security and masking on invented data, and the Worker replaces each visitor’s IP address with a keyed hash before the app sees it.',
    arch: [
      ['Staff', 'browser · company sign-in'],
      ['Next.js app', 'Cloud Run · a role per user'],
      ['Postgres', 'row-level security · audit triggers'],
      ['Connected apps', 'tracker · statements · trades'],
    ],
    demo: 'The demo runs the production app’s code on a fictional firm, with company sign-in replaced by four staff personas: an advisor with her own book, client service, operations and an admin. The Transfer Tracker, the statement pipeline and the data warehouse are replaced by stand-ins that answer in their real formats inside the container, and calls to Google are refused. Each household, transfer, statement and trade request links to the same record in the other live demos. Trade Requests runs on its in-app backend here, even though that backend is still switched off in production. Slack closeout checklists, trade-request messages and operations alerts land in an in-app Outbox instead of being sent. Uploads are off, and a sample statement stands in. Dual-View, which never ran in production, is on for the showcase households and says so. The data resets daily at 07:00 UTC.',
    hero: screen(
      'advice-transfer',
      'The Operations view of Kofi Okafor’s account transfer shows $412,880 moving from Edward Jones to a joint account at Apex, its funding plan from the statement, the transfer at stage 2 of 3, and a link to the same transfer in the Transfer Tracker demo.',
    ),
    gallery: [
      screen(
        'advice-command-center',
        'Command Center, seen as the advisor, shows the transfer pipeline by stage, this week’s meetings, stalled work and recent client signals.',
        'Command Center shows the pipeline, the week’s meetings and what has stalled for whoever is signed in.',
      ),
      screen(
        'advice-portrait',
        'Kofi Okafor’s Client Portrait shows the household and his AUM, his joint account at Apex with its cash and securities, and the account’s beneficiaries.',
        'The Client Portrait puts accounts, AUM, beneficiaries and held-away accounts on one page, within the advisor’s book.',
      ),
      screen(
        'advice-asset-map',
        'Asset Mapping for the Okafor household shows twelve positions from one statement, ten of them eligible for ACAT, the rule that routed each, and a link to the Statement Analyzer demo.',
        'In Asset Mapping, the Statement Analyzer’s results are reviewed and linked to the client and transfer.',
      ),
      screen(
        'advice-acat',
        'The ACAT book groups transfers by status and shows the delivering firm, control number, statement amount, days open and reconciliation state, with a link to the full tracker.',
        'The ACAT book is read live from the Transfer Tracker.',
      ),
      screen(
        'advice-trade',
        'Kofi and Ada Okafor’s rebalance request is under review. The screen shows its status, advisor, the joint account and its value, the client’s risk score, and a link to the same request in the Trade Request demo.',
        'Trade requests are reviewed inside the platform. Once approved, a request sets the account’s investment profile when a person confirms it.',
      ),
    ],
  },
  {
    slug: 'help-desk',
    name: 'WM Help Desk',
    kicker: 'Client service platform',
    color: 'var(--help)',
    icon: 'inbox',
    host: 'helpdesk',
    status: 'live',
    card: 'This help desk has several queues and role-based access. It redacts PII before storage, runs SLA clocks and keeps a tamper-evident audit ledger.',
    summary:
      'Built for a registered investment adviser, this multi-queue help desk has books-and-records controls designed in from the start. Access is role-based, PII is redacted before anything is stored, SLAs are tracked, and the audit ledger is hash-chained.',
    stack: ['Next.js', 'TypeScript', 'Prisma', 'Postgres', 'Auth.js', 'Vitest'],
    meta: [
      ['Role', 'Design, engineering, rollout'],
      ['Users', 'Client service, operations, advisors, compliance'],
      ['Stack', 'Next.js · Prisma · Postgres'],
    ],
    problem:
      'Client service ran on a general-purpose ticketing tool. Internal notes and client replies sat side by side, account numbers and Social Security numbers landed in free text, and there was no way to show a reviewer that a record had not been changed after the fact.',
    built: [
      'Operations, client service and advice each have a queue, and group membership sets who can read or write in it. Compliance can read every queue but can’t change a ticket.',
      'Internal notes live in a separate visibility channel that client-facing views cannot query.',
      'PII is redacted before the write, so the database never holds a full SSN or account number.',
      'Email intake threads a client’s reply onto its ticket, checks the sender’s authentication and holds anything suspect for review.',
      'Common replies use approved macros, and every client reply gets a firm-approved disclaimer. Sent replies wait in a queue for compliance to review.',
      'SLA clocks show On track, Warning and Breached states, and alerts go out before a breach.',
      'The audit ledger is append-only, and each entry carries the hash of the one before it. A check re-verifies the whole chain on demand.',
      'The interface is phone-first, with a single layout breakpoint, because most triage happens away from a desk.',
    ],
    decisions: [
      ['Redact on the way in', 'Masking at display time still leaves raw values in backups and exports. Redacting before the write means there is nothing to leak.'],
      ['Enforce visibility where data is read', 'Client-facing reads go through a database view that holds no internal notes, so a new client-facing screen cannot expose one by accident.'],
      ['Hash-chain the audit log', 'Each row stores the previous row’s hash, and the database refuses to update or delete one. Re-verifying the chain proves no entry was edited or removed.'],
      ['Write the contract first', 'The architecture document sets 15 invariants, each enforced in code and checked by tests that run in CI, so a change that breaks one fails the build.'],
    ],
    security:
      'The database is reachable only over a private network and accepts only encrypted connections. It is encrypted at rest with a customer-managed key that rotates every 90 days, and attachments sit in a bucket encrypted the same way. Social Security, card and account numbers are redacted before anything is stored. The audit ledger is a SHA-256 hash chain that the database itself enforces, reply links and webhooks are signed with HMAC, and API tokens are stored only as SHA-256 hashes. The demo runs the same redaction, signing and hash-chain code on invented data, with a new reply-link secret and database password on every deploy.',
    arch: [
      ['Browser', 'phone · desktop'],
      ['Next.js app', 'RBAC · redaction · SLA'],
      ['Postgres', 'tickets · audit ledger'],
      ['Scheduler', 'SLA alerts'],
    ],
    demo: 'The demo runs the production app’s code on a fictional firm, with sign-in replaced by four staff personas: operations, client service, advisor and compliance. The mail sender and Slack are replaced by stand-ins inside the container, so every client email and SLA alert lands in an in-app Outbox instead of being sent. Two buttons there play the client, sending a new email or a reply through the app’s real email intake. AI drafts come from canned text, and uploads are off, though the seeded attachments still open. Webhooks, web push and the client API are switched off. The data resets daily at 14:00 UTC.',
    hero: screen(
      'help-dashboard',
      'The help desk dashboard shows open tickets in the Operations, Client Service and Advice queues, with counts of unassigned, warning and breached tickets, above a filterable ticket list sorted by SLA.',
    ),
    gallery: [
      screen(
        'help-ticket',
        'An urgent wire-transfer ticket is past its SLA. The screen shows the client’s request, a client-visible reply with its wire-verification disclaimer, and the ticket’s status, priority, assignee and queue.',
        'In a ticket’s thread, client replies and internal notes are kept apart, and every client reply carries its disclaimer.',
      ),
      screen(
        'help-outbox',
        'The Outbox holds an email the desk sent to a client and the SLA sweep’s Slack alert listing breached and warning tickets.',
        'The Outbox collects every client email and Slack alert the demo would have sent, and its buttons answer as the client.',
      ),
      screen(
        'help-audit',
        'The compliance audit log after a chain verification shows every row re-hashing to its stored hash and linking to the one before it, above a filterable list of sign-ins and views.',
        'In the audit ledger, one click re-hashes the whole chain, and the check itself is recorded.',
      ),
      screen(
        'help-reviews',
        'The reply review queue lists public replies from the last 30 days awaiting supervisory review, oldest first, each with its disclaimer and a Review button.',
        'Client replies wait in this queue, oldest first, until compliance gives them a supervisory review.',
      ),
    ],
  },
  {
    slug: 'trade-request',
    inside: 'always-on-advice',
    name: 'Trade Request',
    kicker: 'Trading workflow',
    color: 'var(--trade)',
    icon: 'arrow-right-left',
    host: 'trade',
    status: 'live',
    card: 'Advisors send trade requests to traders through this workflow, which includes an asset-location engine, drift monitoring and a compliance record for every request.',
    production: 'used daily by a 4-person trading team and shipped through 126 production deploys.',
    summary:
      'Advisors submit structured trade requests, and traders work them from a queue with a pre-approval checklist. An asset-location engine turns each request into an execution plan, and a drift monitor compares every account with its model portfolio.',
    stack: ['React', 'Vite', 'Express', 'Postgres', 'TypeScript', 'Zod'],
    meta: [
      ['Role', 'Design and engineering'],
      ['Users', 'Advisors and traders'],
      ['Stack', 'React · Express · Postgres'],
    ],
    problem:
      'Trade requests arrived by chat and email with missing details. Traders re-keyed them into spreadsheets, chased follow-up questions, and had no single record of who approved what and when.',
    built: [
      'The request form adapts to the request type and won’t submit an incomplete request.',
      'The trading queue is searchable and shows the status, advisor and submitter of every request.',
      'Every request carries a pre-approval checklist and an audit trail, so each approval shows what was checked and who decided.',
      'An asset-location engine places cash and fixed income in the account where each is taxed least.',
      'A drift monitor compares every account with its model portfolio. It can rank accounts by unrealized gain so the cheapest fixes come first, and it lets a trader mark known exceptions.',
      'Every request gets a compliance PDF, and a firm-wide compliance report shows what was asked, what was approved and by whom.',
      'Client and server share domain types, so a renamed field fails the build on both sides.',
    ],
    decisions: [
      ['Structured requests only', 'Free-text requests were the root problem, so each request type has its own required fields and validation.'],
      ['The engine is a pure function', 'Asset location takes holdings and a model and returns a plan. Because it never touches the database, it’s simple to test against fixtures.'],
      ['Approval before execution', 'Nothing is traded straight from a request. A trader approves a plan, and that approval becomes part of the record.'],
      ['One deployable unit', 'Express serves the built React app, which keeps hosting simple and inexpensive.'],
    ],
    security:
      'Sessions are kept on the server and tied to HttpOnly, Secure cookies with CSRF protection. Calls from other services need a Google-verified identity token, the app reaches its database through Cloud SQL with the data encrypted at rest by Google Cloud, and the logger strips credentials and personal fields before anything is written. The demo keeps the session, CSRF and logging code and connects to its Neon database over TLS with a verified certificate.',
    arch: [
      ['Advisor / Trader', 'browser'],
      ['React SPA', 'forms · queue · plans'],
      ['Express API', 'engine · drift · PDF'],
      ['Postgres', 'requests · approvals'],
    ],
    demo: 'The demo runs the production app’s code on a fictional firm. The data warehouse, the model provider’s feeds and Slack are replaced by stand-ins that answer in their real formats inside the container, and every Slack message and email lands in an in-app Outbox instead of being sent. A nightly reset restores the data and replays two weeks of drift checks, so the history always looks current.',
    hero: screen(
      'trade-drift',
      'The drift monitor compares 93 accounts with their model portfolios. It shows counts of accounts out of tolerance and uninvested, and a table of accounts ranked by how far they have drifted.',
    ),
    gallery: [
      screen(
        'trade-queue',
        'The trading queue is a searchable table of trade requests with household, trade type, date, advisor, submitter and status.',
        'Traders can search every request in the queue and see its status and who submitted it.',
      ),
      screen(
        'trade-request',
        'A rebalance request is open for review, showing its status, the selected account, the client’s risk level and the allocation it sets, with Approve and Reject buttons.',
        'While a request is under review, the audit trail and the pre-approval checklist are a tab away, and approval is recorded with a note.',
      ),
      screen(
        'trade-outbox',
        'The Outbox shows Slack messages the app would have sent, including the daily drift report and the morning digest of open requests.',
        'The Outbox keeps every Slack message and email the demo would have sent, including the daily drift report.',
      ),
    ],
  },
  {
    slug: 'transfer-tracker',
    inside: 'always-on-advice',
    name: 'Transfer Tracker',
    kicker: 'Account transfers',
    color: 'var(--xfer)',
    icon: 'route',
    host: 'transfers',
    status: 'live',
    card: 'Account transfers are tracked from request to settlement, with every position reconciled and transfer forms filled from the record. Each delivering firm has its own playbook.',
    production: 'the ops team’s system of record for 640+ transfers across 37 custodians.',
    summary:
      'The Transfer Tracker follows brokerage account transfers from request to settlement. It keeps every transfer’s status and history, reconciles them position by position against the clearing firm’s report, fills transfer forms from the account record, and holds a playbook and fee schedule for each delivering firm, along with cycle-time analytics.',
    stack: ['Next.js', 'React', 'Prisma', 'Postgres', 'pdf-lib', 'Zod'],
    meta: [
      ['Role', 'Design and engineering'],
      ['Users', 'Transfer team, admins and advisors'],
      ['Stack', 'Next.js · Prisma · Postgres'],
    ],
    problem:
      'Transfers were tracked in a spreadsheet while the real status lived in each custodian’s portal. Rejections surfaced late, partial transfers left residual positions behind, and transfer fees were reimbursed late or not at all.',
    built: [
      'A records view groups all transfers by status, with quick filters for each person’s queue, open issues and fees still to submit.',
      'Each transfer opens in a detail drawer with its full history of who changed what, and when.',
      'Reconciliation works position by position, matching the holdings expected from the client’s statement against the clearing firm’s report of what arrived.',
      'Transfer forms are filled from the account record as a PDF, chosen by the delivering firm’s rules and saved with the transfer.',
      'Each delivering firm has a playbook with its DTC number, signature and medallion requirements, contact method, fee schedule and processing time.',
      'Fees are applied from the delivering firm’s schedule, and each reimbursement requested is logged.',
      'Analytics cover cycle time, monthly volume and each firm’s performance, alongside residual-sweep monitoring and data-quality checks.',
      'Advisors get a read-only view of every transfer, without account numbers, fees or internal notes.',
    ],
    decisions: [
      ['Pick clients, never type them', 'Each transfer links to people in the firm’s client directory, so a misspelled name cannot split a client’s history or reach a form.'],
      ['Custodian rules are data', 'Requirements, contacts and fees live in records. Each fee notes the schedule it came from, and the original schedule stays on file.'],
      ['Generate forms, never retype', 'Form fields come from the account record, and the account title is confirmed against the clearing firm before a form is built.'],
      ['Archive, never delete', 'A deleted transfer is archived with a reason and can be restored, so its history survives a mistake.'],
    ],
    security:
      'Every page is served with HSTS and a fresh Content Security Policy for each request. Other systems must present a Google-signed identity token from an allow-listed service account, and the app reaches its database through Google’s Cloud SQL connector, with the data encrypted at rest by Google Cloud. Tokens for the AI-assistant connection are stored only as keyed hashes, and that connection sees just the last four digits of account numbers. The demo keeps the headers and masking, and the machine and assistant connections are switched off.',
    arch: [
      ['Transfer team', 'browser'],
      ['Next.js app', 'records · recon · forms'],
      ['Postgres', 'transfers · custodians · history'],
      ['Statement Analyzer', 'expected positions'],
    ],
    demo: 'The demo runs the production app’s code on a fictional firm, with sign-in replaced by three staff personas: transfers, admin and advisor. The fee store, the client directory, the statement pipeline and Slack are replaced by stand-ins that answer in their real formats inside the container, and every Slack message lands in an in-app Outbox instead of being sent. Uploads are off, so the clearing firm’s report comes from a bundled sample, and seeded fee summaries can be opened. The custodian library is the production one, with every delivering firm’s DTC number, requirements, notes and published fees. A nightly reset restores the data.',
    hero: screen(
      'xfer-dashboard',
      'The transfer operations dashboard shows 124 transfers, 101 completed, 3 rejected and 17 active, with a chart of monthly transfer requests by workflow.',
    ),
    gallery: [
      screen(
        'xfer-records',
        'All records are grouped by status, showing each transfer’s client, status, delivering firm, direction, advisor, control number, statement amount and days open.',
        'All transfers are grouped by status, and quick filters cover each person’s queue, open issues and fees still to submit.',
      ),
      screen(
        'xfer-recon',
        'A completed transfer in the detail drawer shows seven positions loaded from asset mapping, all seven matched to the clearing firm’s report, and a table of positions with their transfer eligibility and statement date.',
        'Reconciliation for one transfer matches the positions expected from the statement against what the clearing firm reports arriving.',
      ),
      screen(
        'xfer-custodian',
        'A delivering firm’s playbook lists its DTC number, transfer type, signature and medallion requirements, contact method, transfers to date and recent clients.',
        'Each delivering firm has a playbook, with its fee schedule below and the original schedule kept on file.',
      ),
      screen(
        'xfer-advisor',
        'The advisor view lists active transfers with client, delivering firm, direction, value and status, and one of them is opened to show its dates and the firm’s expected processing time.',
        'The advisor view is read-only and leaves out account numbers, fees and internal notes.',
      ),
    ],
  },
  {
    slug: 'statement-analyzer',
    inside: 'always-on-advice',
    name: 'Statement Analyzer',
    kicker: 'Document processing',
    color: 'var(--stmt)',
    icon: 'file-search',
    host: 'statements',
    status: 'live',
    card: 'Model-based extraction works alongside a tested 15-layer rule chain. Together they cut statement review from 30–45 minutes to under a minute.',
    production: '320+ statement files parsed for ~40 client households.',
    summary:
      'The Statement Analyzer extracts every account and position from a brokerage statement and decides what can transfer in kind. A language model reads the document, and a tested, deterministic rule chain makes every decision.',
    stack: ['Python', 'FastAPI', 'Gemini', 'Postgres', 'React', 'fpdf2'],
    meta: [
      ['Role', 'Design and engineering'],
      ['Impact', 'Review time 30–45 min → under 60 s'],
      ['Stack', 'Python · FastAPI · React'],
    ],
    problem:
      'Before each transfer, someone read the client’s statements by hand to list every account and holding and spot anything that could not move. It took 30 to 45 minutes per client, and mistakes surfaced weeks later as rejected transfers.',
    built: [
      'A pre-check turns away files that aren’t investment statements and flags any that are too old to rely on.',
      'Extraction turns every account, position, quantity, value and cost basis into structured data, including statements that hold several accounts, or several registrations under one investor number.',
      'A 15-layer rule chain routes each position, marking it transfer in kind, sell first, move by ACH or wire, unsupported at the receiving firm, or needs review.',
      'A totals check sends the whole account to review when the extracted positions don’t add up to the statement’s printed total.',
      'A household view spans all of a household’s statements and runs. Operations gets a view for overrides, deletes and account-type changes, and advisors get a read-only Client Service view.',
      'The app suggests accounts to open at the receiving firm and checks them against each owner’s existing accounts.',
      'Results export to PDF and CSV, and the Transfer Tracker reads positions through an API.',
    ],
    decisions: [
      ['The model only reads', 'The language model turns a PDF into data. Every decision comes from deterministic, tested rules, so a reviewer can see exactly why.'],
      ['Stop at the first rule that decides', 'Each position runs down the chain until one layer decides, and the screen shows which rule it was and why, so a wrong answer is quick to trace.'],
      ['Totals must reconcile', 'Extracted positions must add up to the statement total, or the whole account goes to review.'],
      ['Cache the expensive step', 'Extraction runs once per document. Changing an account’s type re-runs only the rules, with no model call.'],
    ],
    security:
      'Every caller must present a verified Google identity token, and the database is reached through Cloud SQL with short-lived IAM credentials, with the data encrypted at rest by Google Cloud. Each statement is read into a temporary file that is deleted once extraction finishes, and the review view shows only the last four digits of account numbers. The demo never reads a real statement or calls a model, keeps the same masking, and signs its sign-in cookie with HMAC.',
    arch: [
      ['Drive folder', 'statement PDFs'],
      ['Extraction', 'LLM → JSON'],
      ['Rule chain', '15 layers · tested'],
      ['Household view', 'review · PDF'],
    ],
    demo: 'The demo runs an adapted version of the real app’s code on a fictional firm, with sign-in replaced by two staff personas: a transfer specialist in the Operations view and an advisor in the read-only Client Service view. It never calls a model. Each sample statement’s pre-screen and extraction answers are prepared from the statement itself, in the JSON the app’s prompts ask for, and the app’s own code does the rest live, from the asset types and transfer rules to the totals check and the write. Nine sample households (twelve statements) cover the cases the rules exist for, from a trust the receiving firm can’t take to a statement whose positions don’t add up. Runs start from a sample panel instead of a Drive folder, and the Slack scan summary and the reports saved to Drive land in an in-app Outbox. The scheduled scan, the machine APIs and the MCP server are switched off. The data resets daily at 07:00 UTC.',
    hero: screen(
      'stmt-household',
      'The Okafor household in the Operations view shows three accounts from one Edward Jones statement, counts by status with ten positions eligible for ACAT and two for review, and the accounts to open at the receiving firm.',
    ),
    gallery: [
      screen(
        'stmt-rules',
        'A joint account’s positions are listed with shares, value, cost basis and classification, the rule engine’s status for each, and the rule that decided it. A Bridge Builder mutual fund is held for review.',
        'Every position shows its status and the rule that decided it.',
      ),
      screen(
        'stmt-blocked',
        'On a revocable trust’s statement, a hard-block banner says trusts aren’t supported at the receiving firm, and every position is marked unsupported with that rule as the reason.',
        'The receiving firm can’t take this trust, so every position is blocked, with the reason shown.',
      ),
      screen(
        'stmt-samples',
        'During a run, the sample statements panel shows a progress bar naming the current step, above the three chosen sample households and a note that the demo has no live model.',
        'A run from the sample panel takes about a minute, and the panel says plainly that the extraction is prepared.',
      ),
      screen(
        'stmt-advisor',
        'The advisor’s Client Service view of the same household shows 88% of its value ready for ACAT transfer, the account ready to submit, and an action plan for the rest.',
        'The advisor’s read-only view is sorted for the client conversation.',
      ),
      screen(
        'stmt-outbox',
        'The Outbox holds a household report saved to the client’s Drive folder and the Slack scan summary, both kept in the demo instead of sent.',
        'The Outbox keeps the Slack summaries and Drive saves the app would have sent.',
      ),
    ],
  },
];
