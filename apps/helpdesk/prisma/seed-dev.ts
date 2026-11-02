/**
 * The demo's data: `seedFromUniverse` — steps 3 and 5–9 of docs/ARCHITECTURE.md §j. Never imported by app code.
 *
 * Staff from the shared synthetic universe, the 38 hand-written tickets across every category / priority /
 * status, the universe's eight story tickets, about 150 resolved tickets of history, PII fixtures whose
 * redaction is ASSERTED before persistence, a negative control, comments with disclaimers appended into the
 * stored body, macros applied, seeded attachments, audit rows (incl. views, a preview and an AUTHZ_DENIED),
 * and a final hash-chain verification.
 *
 * Same controls as the app: `sanitizePII` / `sanitizeFields` before any Prisma write, `SYSTEM_ACTOR`,
 * `systemRequestContext("seed")`, and each ticket's `writeAuditMany` as the last statement of that
 * ticket's writes. One difference from the source: everything runs inside ONE transaction the caller owns
 * (`db`), so the nightly reset's wipe and this seed commit together or not at all. Never deletes anything.
 * Guarded against production twice (here and in seed.ts).
 */
import { addMinutes, format as formatDate, subMinutes } from "date-fns";
import type { Prisma } from "@prisma/client";
import type { DbTx } from "../src/lib/db";
import {
  SYSTEM_ACTOR,
  deniedEntityType,
  serializeAuditValue,
  systemRequestContext,
  verifyChainRows,
  writeAudit,
  writeAuditMany,
} from "../src/lib/audit";
import type { AuditChainRow } from "../src/lib/audit";
import { formatPiiCounts, sanitizeFields, sanitizePII } from "../src/lib/pii";
import { computeDueDates, computeSlaStatus, slaPolicyFor } from "../src/lib/sla";
import { routeCategory } from "../src/lib/routing";
import { appendDisclaimer } from "../src/lib/disclaimers";
import { canComment, canCreateTicket, canReadQueue, canWriteQueue } from "../src/lib/rbac";
import { canTransition } from "../src/lib/ticket-policy";
import { buildDemoAttachments, demoTicketId } from "../src/lib/demo/attachments";
import type { DemoAttachment } from "../src/lib/demo/attachments";
import { lastDeskClose, viewingStart } from "../src/lib/demo/universe";
import type { Universe } from "../src/lib/demo/universe";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "../src/types/domain";
import type {
  AuditActor,
  AuditEntry,
  CommentVisibility,
  DisclaimerKey,
  EscalationTarget,
  OktaGroup,
  PiiKind,
  QueueKey,
  SlaPhase,
  SlaPolicyInput,
  SlaStatus,
  TicketBrand,
  TicketCategory,
  TicketPriority,
  TicketSource,
  TicketStatus,
} from "../src/types/domain";
import { HISTORY_FIRST_NUMBER, INTERNAL_MARK, historyFixtures, placeForViewing, storyFixtures } from "./seed-universe";

// ---------------------------------------------------------------------------
// Step 3 — users
// ---------------------------------------------------------------------------

export type StaffId =
  | "staff_marco"
  | "staff_rachel"
  | "staff_helen"
  | "staff_priya"
  | "staff_sam"
  | "staff_ethan"
  | "staff_dana"
  | "staff_jordan"
  | "staff_former";

type StaffSeed = { id: StaffId; universeId: string | null; groups: OktaGroup[]; isActive: boolean };

/**
 * The universe's eight staff plus one former employee. Ids are stable across resets so the persona sign-in
 * can point at them; names and emails come from the universe. Groups follow each person's job at the desk:
 * Sam Ortiz is the desk supervisor who works every queue, and the transfer specialist works Client Service
 * and Operations both.
 */
const STAFF_SEED: readonly StaffSeed[] = [
  { id: "staff_marco", universeId: "marco-ferreira", groups: ["ops_team"], isActive: true },
  { id: "staff_helen", universeId: "helen-carver", groups: ["client_services"], isActive: true },
  { id: "staff_rachel", universeId: "rachel-moss", groups: ["advisors"], isActive: true },
  { id: "staff_priya", universeId: "priya-nair", groups: ["compliance_officers"], isActive: true },
  { id: "staff_sam", universeId: "sam-ortiz", groups: ["ops_team", "client_services", "advisors"], isActive: true },
  { id: "staff_ethan", universeId: "ethan-cole", groups: ["ops_team"], isActive: true },
  { id: "staff_dana", universeId: "dana-pruitt", groups: ["advisors"], isActive: true },
  { id: "staff_jordan", universeId: "jordan-reyes", groups: ["client_services", "ops_team"], isActive: true },
  // Inactive on purpose: demonstrates getViewer() lockout and the assignable-user filter.
  { id: "staff_former", universeId: null, groups: ["client_services"], isActive: false },
];

type UserRow = { id: string; email: string; name: string | null; groups: OktaGroup[]; isActive: boolean };

/** `first.last@example.com`, the firm's address for a universe staff member. */
const staffEmail = (name: string): string => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

async function seedUsers(db: DbTx, universe: Universe, now: Date): Promise<Map<StaffId, UserRow>> {
  const users = new Map<StaffId, UserRow>();
  for (const s of STAFF_SEED) {
    const person = s.universeId === null ? null : universe.staff.find((x) => x.id === s.universeId);
    if (s.universeId !== null && !person) throw new Error(`universe has no staff member ${s.universeId}`);
    const name = person?.name ?? "Former Staff";
    const email = person ? staffEmail(person.name) : "former.staff@example.com";
    const row = await db.user.upsert({
      where: { id: s.id },
      create: { id: s.id, email, name, groups: s.groups, isActive: s.isActive, emailVerified: now },
      update: { email, name, groups: s.groups, isActive: s.isActive },
      select: { id: true, email: true, name: true, groups: true, isActive: true },
    });
    users.set(s.id, row);
  }
  return users;
}

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

/** What sanitizePII must report for a fixture string. `kinds` = every kind that must be redacted ≥ 1. */
export type PiiExpectation = { redacted: boolean; kinds?: PiiKind[]; fields?: string[] };

export type CommentFixture = {
  visibility: CommentVisibility;
  authorId: StaffId;
  /** Minutes after ticket creation. */
  atMin: number;
  /** Raw body; PUBLIC bodies get the disclaimer appended AFTER sanitization, like addPublicReply. */
  body?: string;
  /** Renders the macro body (with placeholders) instead of `body`; audited as MACRO_APPLIED. */
  macroKey?: string;
  /** PUBLIC only. Defaults to the macro's disclaimer, else the category's routed default. */
  disclaimerKey?: DisclaimerKey;
  expectPii?: PiiExpectation;
};

export type TicketFixture = {
  /** Stable label for logs and cross references (never persisted). */
  ref: string;
  /** A fixed HD number (the universe's story tickets). Everything else is numbered in creation order. */
  number?: number;
  category: TicketCategory;
  /** Override of the routed default → TICKET_PRIORITY_CHANGED row, like createTicket. */
  priority?: TicketPriority;
  status: TicketStatus;
  createdMinAgo: number;
  createdById: StaffId;
  assigneeId?: StaffId;
  subject: string;
  description: string;
  clientReference?: string;
  requesterName: string;
  /**
   * NULLABLE since Wave A: a voicemail or inbound call has a phone and no address.
   * The DB CHECK `ticket_requester_contact_present` requires at least one of email / phone, and
   * validateFixtures asserts the same thing before any write.
   */
  requesterEmail: string | null;
  /** E.164 (`+` then 8..15 digits, first digit 1-9). Contact data, never a redaction target. */
  requesterPhone?: string;

  // --- Wave A columns. Omitted = the column default. ---
  /** Sending identity family; drives From / Reply-To and the disclaimer variant. Default CEDAR_RIDGE_WEALTH. */
  brand?: TicketBrand;
  /** How the ticket entered the desk. Default STAFF_FORM, which is accurate for a staff-filed request. */
  source?: TicketSource;
  /** Upstream id, unique per source (Gmail Message-ID, phone system call id). Keeps a replay idempotent. */
  externalId?: string;
  /** One external reference (e-signature envelope, ACAT control number). Sanitized like free text. */
  externalRef?: string;
  /** The advisor platform pointers — ids only, never account numbers. */
  householdId?: string;
  requesterExternalId?: string;
  /**
   * Flags a staff member applied AFTER intake, at +`flaggedAtMin` — one `updateTicketFields` call, so
   * one version bump and one TICKET_FIELD_CHANGED row per field. `complaintFiledAt` is stamped at that
   * moment and never cleared, exactly as updateTicketFields stamps it.
   */
  isComplaint?: boolean;
  escalationTarget?: EscalationTarget;
  /**
   * Unresponsive-client cadence, in minutes from `now` — positive is still due, negative is overdue.
   * Measured from `now` rather than from `createdAt` because the column is a FUTURE date the
   * due/overdue filters read, not a back-dated event like resolvedAt.
   */
  followUpInMin?: number;
  /** Minutes after creation at which the three fields above were applied. Required when any is set. */
  flaggedAtMin?: number;
  /** Minutes after creation; required for RESOLVED / CLOSED. */
  resolvedAtMin?: number;
  /** Minutes after creation; required for CLOSED. */
  closedAtMin?: number;

  // --- Wave B. All three are required together for a VOIDED fixture and forbidden
  // otherwise, exactly as the DB CHECK `ticket_void_fields_consistent` demands.
  /** Minutes after creation at which the ticket was voided. */
  voidedAtMin?: number;
  /** ops_team only — `canVoidTicket` is `ops_team && canWriteQueue`, re-checked in validateFixtures. */
  voidedById?: StaffId;
  /** >= 12 characters (DB CHECK `ticket_void_reason_length`). Sanitized like every other free text. */
  voidReason?: string;

  comments: CommentFixture[];
  /** Seeded attachments (src/lib/demo/attachments.ts), added by `uploaderId` at +`atMin`. */
  attachments?: Array<{ id: string; uploaderId: StaffId; atMin: number }>;
  expectPii?: PiiExpectation;
  /**
   * Asserted with computeSlaStatus after the write — the seed proves the dashboard states exist. Read at
   * the seed's `now`, at the desk's last close when `slaAt` is "CLOSE", or at the first viewing hour when it
   * is "VIEW" (both set by `placeForViewing`). History tickets leave it out.
   */
  expectSla?: { phase: SlaPhase; status: SlaStatus };
  slaAt?: "SEED" | "CLOSE" | "VIEW";
  /**
   * Where this open ticket's resolution clock should stand when the first visitor looks. `placeForViewing`
   * re-times the ticket to get there when its events still fit before the reset; the hand-written tickets
   * derive it from `expectSla`.
   */
  viewTarget?: "ON_TRACK" | "WARNING";
};


/**
 * PII strings the seed feeds through sanitizePII. After seeding, NONE of them may exist in the database.
 *
 * `021000021` LEFT this list with Decision #116. It is the routing number in the OPS-01 fixture, and
 * the desk deliberately no longer redacts routing numbers — so asserting its absence would assert the
 * opposite of the decision. It is asserted PRESENT instead, by `assertRoutingNumberPersisted` below,
 * because "the routing number survives while the account number beside it does not" is the whole
 * substance of the change and is worth proving against a real database rather than only in a unit test.
 */
const RAW_PII_PROBES: readonly string[] = [
  "000123456789",
  "123-45-6789",
  "4111 1111 1111 1111",
  "123456789",
  // The non-nine-digit half of the routing guard. `021000021` passes through because it IS an ABA
  // number; `4455667788` sits behind the same `routing` marker and is ten digits, so it cannot be one —
  // it is the account number a client transposed into the routing field. A probe of only nine-digit
  // shapes would have gone green while that value persisted raw, which is why this one is here.
  "4455667788",
];

/** The routing number in the OPS-01 fixture — redacted until Decision #116, deliberately not since. */
const PASS_THROUGH_ROUTING_PROBE = "021000021";

// ---------------------------------------------------------------------------
// Step 5–7 — the 37 tickets (22 categories; 4 priorities; 6 statuses)
//
// The queues are no longer evenly split. The original 24 were 8/8/8 because the original eleven
// categories were; Wave A appended eleven more that Operations and Client Service work
// and Advice does not, so the distribution now follows ROUTING_TABLE rather than a round number —
// EXPECTED_FIXTURES_PER_QUEUE below is the assertion, and it is derived from the list, not guessed.
//
// SLA design (calendar minutes, now = seed start):
//   FIRST_RESPONSE BREACHED : OPS-01 (URGENT, 180 m, no reply), OPS-03 (URGENT, 120 m), ADV-07 (HIGH, 70 m),
//                             OPS-15 (STANDARD, 300 m, VOIDED — breached on the raw timers, and excluded
//                             from every counter by METRICS_EXCLUDED_STATUSES; Wave B, Decision #96)
//   FIRST_RESPONSE WARNING  : CS-13 (HIGH, 45 m, voicemail, NEW so no public reply is possible)
//   RESOLUTION WARNING      : OPS-05 (STANDARD, 23 h 45 m, replied), CS-03 (STANDARD, 23 h 35 m, replied),
//                             OPS-12 (HIGH, 7 h 50 m, replied), CS-12 (URGENT complaint, 95 m, replied)
//   RESOLUTION BREACHED     : OPS-06 (STANDARD, 2 days, replied, not resolved)
//   COMPLETE MET            : OPS-04, ADV-06, OPS-08 (closed), CS-08 (closed), OPS-10 (closed),
//                             OPS-14, CS-10, CS-14 (closed)
//   COMPLETE BREACHED       : CS-04 (late first response)
//   late first response with an open resolution clock: ADV-04
//
// Wave A columns exercised: CS-13 is phone-only (requesterEmail null, source VOICEMAIL); CS-12 carries
// isComplaint / complaintFiledAt / escalationTarget COMPLIANCE; CS-10 is source EMAIL on brand
// CEDAR_RIDGE_DIRECT; OPS-12 carries followUpAt; OPS-14 carries the advisor platform household pointers. Everything else
// is STAFF_FORM on CEDAR_RIDGE_WEALTH, which is what the original 24 have always been.
// ---------------------------------------------------------------------------

const TICKET_FIXTURES: readonly TicketFixture[] = [
  // ----- OPERATIONS -----
  {
    ref: "OPS-01",
    category: "WIRE_TRANSFER",
    status: "NEW",
    createdMinAgo: 180,
    createdById: "staff_marco",
    subject: "Outgoing wire to new third-party payee — verification needed",
    // §j.6 PII fixture, verbatim. The commas are deliberate: a trailing sentence comma is NOT number
    // punctuation and must not suppress rule 4.
    //
    // Two kinds since Decision #116, not three. The routing number is still in the sentence ON
    // PURPOSE: it is the fixture that proves a wire instruction keeps its ABA number while the
    // account number beside it is still redacted — the "the pair is still broken" claim, seeded.
    description:
      "Client wants to wire to routing 021000021, acct 000123456789, SSN 123-45-6789 for verification. " +
      "Payee is a title company for a home closing on Friday; client has not been called back yet. " +
      // The second half of the routing guard, seeded against a real row. `4455667788` follows the SAME
      // `routing` marker that lets `021000021` through two sentences earlier, but it is TEN digits, so
      // it cannot be an ABA number — it is the account number the client put in the wrong field, and it
      // must still be redacted. `assertNoRawPiiPersisted` fails if it is not, which is what a
      // nine-digit-only probe set could never catch.
      "Second attempt: client gave the same number twice — account 4455667788, routing 4455667788.",
    clientReference: "Delgado Family Trust · trust",
    requesterName: "Marisol Delgado",
    requesterEmail: "marisol.delgado@example.com",
    expectPii: { redacted: true, kinds: ["ACCOUNT", "SSN"], fields: ["description"] },
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 5,
        body: `${INTERNAL_MARK}: new payee, first wire to this beneficiary. Needs verbal callback before release.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_ethan",
        atMin: 95,
        body: `${INTERNAL_MARK}: left voicemail on the number on file; no callback yet. Cutoff is at four.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "BREACHED" },
  },
  {
    ref: "OPS-02",
    category: "WIRE_TRANSFER",
    status: "OPEN",
    createdMinAgo: 20,
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    subject: "Wire to client's own bank account for quarterly distribution",
    description:
      "Client requests the standing quarterly distribution be wired to the linked checking account rather " +
      "than mailed. Instructions on file match the letter of authorization from onboarding.",
    clientReference: "Goyette household · traditional IRA",
    requesterName: "Saul Goyette",
    requesterEmail: "saul.goyette@example.com",
    comments: [
      { visibility: "PUBLIC", authorId: "staff_marco", atMin: 5, macroKey: "wire-verification-notice" },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 6,
        body: `${INTERNAL_MARK}: callback scheduled for this afternoon; LOA on file dated at onboarding.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "OPS-03",
    category: "TRADE_CORRECTION",
    status: "NEW",
    createdMinAgo: 120,
    createdById: "staff_rachel",
    subject: "Custodian booked a buy as a sell — municipal bond ladder",
    description:
      "Yesterday's purchase of the ten-year rung posted as a sale. Position now shows short. Please open a " +
      "correction with the custodian trade desk; confirmation shows the correct side.",
    clientReference: "Kuhlman household · individual",
    requesterName: "Merlin Kuhlman",
    requesterEmail: "merlin.kuhlman@example.com",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_rachel",
        atMin: 2,
        body: `${INTERNAL_MARK}: confirmation attached in the CRM; side is clearly a buy.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 40,
        body: `${INTERNAL_MARK}: custodian case opened; trade desk says the as-of correction posts tonight.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "BREACHED" },
  },
  {
    ref: "OPS-04",
    category: "TRADE_CORRECTION",
    status: "RESOLVED",
    createdMinAgo: 600,
    createdById: "staff_marco",
    assigneeId: "staff_ethan",
    resolvedAtMin: 90,
    subject: "Duplicate ETF purchase from model rebalance",
    description:
      "The rebalance batch sent the same buy twice for one account. The second fill needs to be reversed " +
      "as a firm error, not charged to the client.",
    clientReference: "Carroll household · Roth IRA",
    requesterName: "Bridgette Carroll",
    requesterEmail: "bridgette.carroll@example.com",
    comments: [
      { visibility: "PUBLIC", authorId: "staff_ethan", atMin: 15, macroKey: "trade-correction-ack" },
      { visibility: "INTERNAL", authorId: "staff_ethan", atMin: 20, macroKey: "wire-callback-completed" },
      {
        visibility: "INTERNAL",
        authorId: "staff_ethan",
        atMin: 85,
        body: `${INTERNAL_MARK}: custodian reversed the second fill to the firm error account. Resolving.`,
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },
  {
    ref: "OPS-05",
    category: "ACAT",
    status: "OPEN",
    createdMinAgo: 23 * 60 + 45,
    createdById: "staff_marco",
    assigneeId: "staff_sam",
    subject: "Incoming ACAT from Edward Jones — status request",
    description:
      "Client transferring the joint account in kind from Edward Jones. Delivering firm shows the " +
      "request as received; client asks for an expected settlement date and whether cost basis will follow.",
    clientReference: "Okafor household · joint taxable",
    // The same transfer the Transfer Tracker demo shows in transit.
    externalRef: "Transfer T-298 · control CTL-10421",
    requesterName: "Kofi Okafor",
    requesterEmail: "kofi.okafor@example.com",
    comments: [
      { visibility: "PUBLIC", authorId: "staff_sam", atMin: 60, macroKey: "acat-status-update" },
      {
        visibility: "INTERNAL",
        authorId: "staff_sam",
        atMin: 61,
        body: `${INTERNAL_MARK}: cost basis usually lags the assets by a few days; watch for the basis file.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "WARNING" },
  },
  {
    ref: "OPS-06",
    category: "ACAT",
    status: "PENDING_CLIENT",
    createdMinAgo: 2 * 24 * 60,
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    subject: "Transfer rejected — account title mismatch",
    description:
      "Delivering firm rejected the transfer because the account title differs (a Jr. suffix). " +
      "Need a corrected transfer form from the client before resubmitting.",
    clientReference: "Rossi household · individual",
    // The Transfer Tracker demo's exception lane shows the same rejection.
    externalRef: "Transfer T-299 · control CTL-10423",
    requesterName: "Anthony Rossi",
    requesterEmail: "anthony.rossi@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_marco",
        atMin: 30,
        body:
          "Hello Anthony, the delivering firm rejected the transfer because the account title on their side " +
          "includes a Jr. suffix. We have sent a corrected transfer form for e-signature; once signed we " +
          "will resubmit the same day.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 35,
        body: `${INTERNAL_MARK}: waiting on the client's e-signature. Resubmit as soon as it lands.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 1500,
        body: `${INTERNAL_MARK}: reminder sent to the client this morning; still unsigned.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "BREACHED" },
  },
  {
    ref: "OPS-07",
    category: "CASH_MOVEMENT",
    status: "PENDING_INTERNAL",
    createdMinAgo: 90,
    createdById: "staff_sam",
    assigneeId: "staff_ethan",
    subject: "Journal cash between household accounts before tax payment",
    description:
      "Move cash from the joint taxable account to the individual account so the estimated tax payment " +
      "clears. Both accounts are in the same household; standing journal authorization is on file.",
    clientReference: "Walker household",
    requesterName: "Paulette Walker",
    requesterEmail: "paulette.walker@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_ethan",
        atMin: 20,
        body:
          "Hello Paulette, we have your request to journal cash between your household accounts. Same-household " +
          "journals under a standing authorization post the next business day; we will confirm once it settles.",
      },
      { visibility: "INTERNAL", authorId: "staff_priya", atMin: 45, macroKey: "escalated-to-compliance" },
      {
        visibility: "INTERNAL",
        authorId: "staff_ethan",
        atMin: 50,
        body: `${INTERNAL_MARK}: holding until compliance confirms the standing authorization covers this pair.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "OPS-08",
    category: "CASH_MOVEMENT",
    priority: "URGENT", // routed default is HIGH → TICKET_PRIORITY_CHANGED at creation
    status: "CLOSED",
    createdMinAgo: 3 * 24 * 60,
    createdById: "staff_marco",
    assigneeId: "staff_marco",
    resolvedAtMin: 100,
    closedAtMin: 200,
    subject: "Same-day ACH to cover an overdraft at the client's bank",
    description:
      "Client's bank flagged an overdraft; requests same-day ACH from the taxable account to the linked " +
      "checking account. Linked account has been on file for more than a year.",
    clientReference: "Friesen household · joint taxable",
    requesterName: "Rodney Friesen",
    requesterEmail: "rodney.friesen@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_marco",
        atMin: 10,
        body:
          "Hello Rodney, your same-day ACH to the linked checking account has been submitted ahead of today's " +
          "cutoff. Funds typically post to your bank by end of day.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 95,
        body: `${INTERNAL_MARK}: custodian confirms the ACH released in the same-day window. Resolving.`,
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },

  // ----- CLIENT_SERVICE -----
  {
    ref: "CS-01",
    category: "PORTAL_RESET",
    status: "OPEN",
    createdMinAgo: 30,
    createdById: "staff_helen",
    assigneeId: "staff_helen",
    subject: "Locked out of portal after phone upgrade",
    description:
      "Client replaced their phone and the authenticator app did not migrate. Locked out after too many " +
      "attempts. Identity confirmed by callback to the number on file.",
    clientReference: "Spencer household",
    requesterName: "Gwen Spencer",
    requesterEmail: "gwen.spencer@example.com",
    comments: [
      { visibility: "PUBLIC", authorId: "staff_helen", atMin: 10, macroKey: "portal-reset-steps" },
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 11,
        body: `${INTERNAL_MARK}: authenticator reset in the admin console; client to re-enroll on the new phone.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "CS-02",
    category: "PORTAL_RESET",
    status: "NEW",
    createdMinAgo: 15,
    createdById: "staff_sam",
    subject: "Spouse cannot see joint account in portal",
    description:
      "Second account holder signed up for the portal but sees only their individual IRA, not the joint " +
      "taxable account. Entitlements likely need to be linked at the household level.",
    clientReference: "Mayer household",
    requesterName: "Lucille Mayer",
    requesterEmail: "lucille.mayer@example.com",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_sam",
        atMin: 3,
        body: `${INTERNAL_MARK}: check the household entitlement mapping before replying.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 8,
        body: `${INTERNAL_MARK}: mapping shows the joint account under the primary only; submitting an entitlement fix.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "ON_TRACK" },
  },
  {
    ref: "CS-03",
    category: "TAX_DOCUMENT",
    status: "OPEN",
    createdMinAgo: 23 * 60 + 35,
    createdById: "staff_helen",
    assigneeId: "staff_jordan",
    subject: "Consolidated 1099 not yet in Documents tab",
    description:
      "Client's accountant is asking for the consolidated 1099. Two of three accounts show the form; the " +
      "taxable account opened mid-year does not yet.",
    clientReference: "Schaden household",
    requesterName: "Mabel Schaden",
    requesterEmail: "mabel.schaden@example.com",
    comments: [
      { visibility: "PUBLIC", authorId: "staff_jordan", atMin: 120, macroKey: "1099-availability" },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 125,
        body: `${INTERNAL_MARK}: the mid-year account is in the custodian's second 1099 wave; check again Friday.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "WARNING" },
  },
  {
    ref: "CS-04",
    category: "TAX_DOCUMENT",
    status: "RESOLVED",
    createdMinAgo: 4 * 24 * 60,
    createdById: "staff_rachel",
    assigneeId: "staff_helen",
    resolvedAtMin: 900,
    subject: "Corrected 1099 needed after reclassified dividend",
    description:
      "A fund reclassified part of a distribution as return of capital after the original 1099 was issued. " +
      "Client needs the corrected form for an amended return.",
    clientReference: "Abbott household · individual",
    requesterName: "Josh Abbott",
    requesterEmail: "josh.abbott@example.com",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 60,
        body: `${INTERNAL_MARK}: custodian says the corrected form is queued for the next correction cycle.`,
      },
      // Late first response: 300 min > the 240-min STANDARD first-response clock → COMPLETE verdict BREACHED.
      {
        visibility: "PUBLIC",
        authorId: "staff_helen",
        atMin: 300,
        body:
          "Hello Josh, the custodian has confirmed a corrected consolidated 1099 will be issued in the next " +
          "correction cycle and will appear in the Documents tab; we will let you know the day it posts.",
      },
      {
        visibility: "PUBLIC",
        authorId: "staff_helen",
        atMin: 890,
        body: "Hello Josh, the corrected 1099 has posted to your Documents tab. Please share it with your accountant.",
      },
    ],
    expectSla: { phase: "COMPLETE", status: "BREACHED" },
  },
  {
    ref: "CS-05",
    category: "ADDRESS_CHANGE",
    status: "PENDING_CLIENT",
    createdMinAgo: 200,
    createdById: "staff_helen",
    assigneeId: "staff_helen",
    subject: "Update mailing address after relocation",
    // §j.6 PII fixture: a card number in a CS ticket.
    description:
      "Client called from the branch and read a card number 4111 1111 1111 1111 for the new statement " +
      "mailing address on file. Asked them to send the new address in writing instead; statements should " +
      "go to the new home from next month.",
    clientReference: "Rau household",
    requesterName: "Lonie Rau",
    requesterEmail: "lonie.rau@example.com",
    expectPii: { redacted: true, kinds: ["CARD"], fields: ["description"] },
    comments: [
      { visibility: "PUBLIC", authorId: "staff_helen", atMin: 30, macroKey: "address-change-verification" },
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 32,
        body: `${INTERNAL_MARK}: waiting on the written address; do not update the custodian record from a phone call.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "CS-06",
    category: "ADDRESS_CHANGE",
    status: "NEW",
    createdMinAgo: 10,
    createdById: "staff_marco",
    subject: "Seasonal address for winter months",
    description:
      "Client wants statements sent to a seasonal address from November through March each year and the " +
      "primary residence otherwise. Custodian supports a seasonal address with start and end dates.",
    clientReference: "Bode household",
    // §j.6 PII fixture: proves the requesterName path is sanitized.
    requesterName: "Elnora Bode SSN 123-45-6789",
    requesterEmail: "elnora.bode@example.com",
    expectPii: { redacted: true, kinds: ["SSN"], fields: ["requesterName"] },
    comments: [
      // §j.6 PII fixture: bare nine digits with SSN context inside an internal note.
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 2,
        body: `${INTERNAL_MARK}: client left a voicemail reading ssn: 123456789 to confirm identity; do not repeat it back.`,
        expectPii: { redacted: true, kinds: ["SSN"] },
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 6,
        body: `${INTERNAL_MARK}: seasonal address form sent for e-signature.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "ON_TRACK" },
  },
  {
    ref: "CS-07",
    category: "OTHER",
    status: "NEW",
    createdMinAgo: 5,
    createdById: "staff_helen",
    subject: "Question about a security identifier on the statement",
    // §j.6 negative control: CUSIP + WM reference + phone must NOT be redacted.
    description: "Please confirm CUSIP 037833100 and reference HD-1042; call 555-123-4567",
    clientReference: "Howell household",
    requesterName: "Alycia Howell",
    requesterEmail: "alycia.howell@example.com",
    expectPii: { redacted: false },
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 1,
        body: `${INTERNAL_MARK}: identifier is the large-cap tech holding; confirm the prior ticket is closed before replying.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_priya",
        atMin: 3,
        body: `${INTERNAL_MARK}: no compliance concern; routine identifier question.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "ON_TRACK" },
  },
  {
    ref: "CS-08",
    category: "OTHER",
    priority: "LOW", // routed default is STANDARD → TICKET_PRIORITY_CHANGED at creation
    status: "CLOSED",
    createdMinAgo: 6 * 24 * 60,
    createdById: "staff_sam",
    assigneeId: "staff_jordan",
    resolvedAtMin: 2000,
    closedAtMin: 3000,
    subject: "Request for paper statements in addition to e-delivery",
    description:
      "Client would like quarterly paper statements mailed in addition to electronic delivery. No urgency; " +
      "next statement cycle is fine.",
    clientReference: "Schinner household",
    requesterName: "Marion Schinner",
    requesterEmail: "marion.schinner@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_jordan",
        atMin: 60,
        body: "Hello Marion, paper statements have been enabled alongside e-delivery starting with the next quarterly cycle.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 1990,
        body: `${INTERNAL_MARK}: delivery preference confirmed on the custodian profile. Resolving.`,
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },

  // ----- ADVICE -----
  {
    ref: "ADV-01",
    category: "REBALANCING",
    status: "OPEN",
    createdMinAgo: 120,
    createdById: "staff_rachel",
    assigneeId: "staff_rachel",
    subject: "Rebalance after large cash deposit",
    description:
      "Client deposited proceeds from a property sale into the taxable account. Requests the cash be " +
      "invested per the current model, staged over two weeks.",
    clientReference: "Reichert household · joint taxable",
    requesterName: "Arch Reichert",
    requesterEmail: "arch.reichert@example.com",
    comments: [
      { visibility: "PUBLIC", authorId: "staff_rachel", atMin: 40, macroKey: "rebalance-ack" },
      {
        visibility: "INTERNAL",
        authorId: "staff_rachel",
        atMin: 42,
        body: `${INTERNAL_MARK}: propose two tranches; check the municipal ladder weights before the second.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "ADV-02",
    category: "REBALANCING",
    status: "PENDING_INTERNAL",
    createdMinAgo: 500,
    createdById: "staff_sam",
    subject: "Drift beyond tolerance band in the conservative model",
    description:
      "Equity sleeve is above the tolerance band after the rally. Client asked whether we intend to " +
      "rebalance before quarter end and what the tax impact would be.",
    clientReference: "Rosenbaum household · rollover IRA",
    requesterName: "Reanna Rosenbaum",
    requesterEmail: "reanna.rosenbaum@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_dana",
        atMin: 100,
        body:
          "Hello Reanna, thank you for flagging the drift. Your advisor is reviewing whether to rebalance before " +
          "quarter end and will send a recommendation with the expected tax impact before any trades.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_dana",
        atMin: 105,
        body: `${INTERNAL_MARK}: waiting on the tax-impact estimate from the planning team.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "ADV-03",
    category: "PLANNING_UPDATE",
    status: "NEW",
    createdMinAgo: 60,
    createdById: "staff_rachel",
    subject: "Update retirement plan for earlier retirement date",
    description:
      "Client is considering retiring two years earlier than planned. Requests an updated plan showing " +
      "the effect on the withdrawal rate and Social Security timing.",
    clientReference: "Nitzsche household",
    requesterName: "Norene Nitzsche",
    requesterEmail: "norene.nitzsche@example.com",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_rachel",
        atMin: 5,
        body: `${INTERNAL_MARK}: rerun the plan with both retirement dates; include the healthcare bridge years.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_dana",
        atMin: 30,
        body: `${INTERNAL_MARK}: draft scenarios ready for advisor review.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "ON_TRACK" },
  },
  {
    ref: "ADV-04",
    category: "PLANNING_UPDATE",
    status: "OPEN",
    createdMinAgo: 3000,
    createdById: "staff_marco",
    assigneeId: "staff_rachel",
    subject: "Add education funding goal for new grandchild",
    description:
      "Client wants a new education goal added to the plan for a grandchild born this month and a " +
      "recommendation on the account type and monthly contribution.",
    clientReference: "Harvey household",
    requesterName: "Obie Harvey",
    requesterEmail: "obie.harvey@example.com",
    comments: [
      // Late first response (600 m > the 480-m LOW clock) with the resolution clock still open.
      {
        visibility: "PUBLIC",
        authorId: "staff_rachel",
        atMin: 600,
        body:
          "Hello Obie, congratulations on the new grandchild. We are adding the education goal to your plan " +
          "and will send a recommendation on the account type and a contribution schedule this week.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_rachel",
        atMin: 610,
        body: `${INTERNAL_MARK}: compare the state plan against a custodial account for the gifting limits.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "ADV-05",
    category: "TAX_LOSS_HARVESTING",
    status: "PENDING_CLIENT",
    createdMinAgo: 300,
    createdById: "staff_rachel",
    assigneeId: "staff_dana",
    subject: "Harvest losses in the international sleeve",
    description:
      "Client read about tax-loss harvesting and asks whether the international equity position with an " +
      "unrealized loss should be harvested before year end, and what the replacement would be.",
    clientReference: "O'Reilly household · individual",
    requesterName: "Skyla O'Reilly",
    requesterEmail: "skyla.oreilly@example.com",
    comments: [
      { visibility: "PUBLIC", authorId: "staff_dana", atMin: 50, macroKey: "tlh-explainer" },
      {
        visibility: "INTERNAL",
        authorId: "staff_dana",
        atMin: 55,
        body: `${INTERNAL_MARK}: asked the client to confirm no purchases of the same fund in the spouse's account.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "ADV-06",
    category: "TAX_LOSS_HARVESTING",
    status: "RESOLVED",
    createdMinAgo: 2 * 24 * 60,
    createdById: "staff_rachel",
    assigneeId: "staff_rachel",
    resolvedAtMin: 1000,
    subject: "Confirm harvested losses were booked",
    description:
      "Client asks for confirmation that the losses harvested last week were realized and the replacement " +
      "fund purchased, plus the realized-loss figure for their records.",
    clientReference: "Hayes household · individual",
    requesterName: "Reynold Hayes",
    requesterEmail: "reynold.hayes@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_rachel",
        atMin: 100,
        body:
          "Hello Reynold, the harvest trades settled and the replacement fund is in place. The realized-loss " +
          "figure is on the trade confirmations in your Documents tab; we will include it in your year-end summary.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_rachel",
        atMin: 990,
        body: `${INTERNAL_MARK}: client confirmed receipt. Resolving.`,
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },
  {
    ref: "ADV-07",
    category: "REBALANCING",
    priority: "HIGH", // routed default is STANDARD → TICKET_PRIORITY_CHANGED at creation
    status: "NEW",
    createdMinAgo: 70,
    createdById: "staff_sam",
    subject: "Client requests exit from a concentrated position before earnings",
    description:
      "Client wants to reduce a concentrated single-stock position ahead of the earnings release later " +
      "this week and asks for the advisor's recommendation today.",
    clientReference: "Franey household · joint taxable",
    requesterName: "Gavin Franey",
    requesterEmail: "gavin.franey@example.com",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_sam",
        atMin: 5,
        body: `${INTERNAL_MARK}: time-sensitive; advisor to call the client before market close.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_priya",
        atMin: 20,
        body: `${INTERNAL_MARK}: no restricted-list conflict on this issuer; proceed on the advisor's recommendation.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "BREACHED" },
  },
  {
    ref: "ADV-08",
    category: "PLANNING_UPDATE",
    status: "OPEN",
    createdMinAgo: 24 * 60,
    createdById: "staff_rachel",
    subject: "Update beneficiaries and estate assumptions in the plan",
    description:
      "Following a change to the client's will, the plan should reflect the new beneficiary split and the " +
      "updated charitable bequest assumption.",
    clientReference: "Murray household",
    requesterName: "Kayden Murray",
    requesterEmail: "kayden.murray@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_rachel",
        atMin: 30,
        body:
          "Hello Kayden, thank you for letting us know about the updated will. We are updating the " +
          "beneficiary split and the charitable assumption in your plan and will walk you through the " +
          "changes at your next review.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_dana",
        atMin: 200,
        body: `${INTERNAL_MARK}: beneficiary forms for the custodian are separate from the plan update; open a CS ticket if needed.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  // ----- OPERATIONS, Wave A categories -----
  {
    ref: "OPS-09",
    category: "ACCOUNT_CLOSURE",
    status: "OPEN",
    createdMinAgo: 200,
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    externalRef: "E-signature envelope ENV-CLOSE-4417",
    subject: "Close the joint taxable account once the final transfer settles",
    description:
      "Household is consolidating to a single account. Close the joint taxable account after the last " +
      "in-kind transfer settles and the residual cash sweeps out; the client asks that nothing be sold " +
      "to fund the closure.",
    clientReference: "Kirlin household · joint taxable",
    requesterName: "Brandy Kirlin",
    requesterEmail: "brandy.kirlin@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_marco",
        atMin: 35,
        body:
          "Hello Brandy, we have the closure instruction. We will wait for the final transfer to settle and " +
          "the residual cash to sweep before closing the account, and nothing will be sold to fund it. We " +
          "will confirm the day the account closes.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 40,
        body: `${INTERNAL_MARK}: closure authorization is out for e-signature; do not submit to the custodian until it returns.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_ethan",
        atMin: 150,
        body: `${INTERNAL_MARK}: residual dividend accrues next week — closing before it posts would strand the credit.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "OPS-10",
    category: "ACCOUNT_CLOSURE",
    status: "CLOSED",
    createdMinAgo: 4 * 24 * 60,
    createdById: "staff_marco",
    assigneeId: "staff_ethan",
    resolvedAtMin: 300,
    closedAtMin: 1500,
    subject: "Close the empty rollover IRA left behind after the consolidation",
    description:
      "The rollover IRA has carried a zero balance since the consolidation and the client would like it " +
      "closed so it stops appearing on statements.",
    clientReference: "Schmeler household · rollover IRA",
    requesterName: "Ryder Schmeler",
    requesterEmail: "ryder.schmeler@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_marco",
        atMin: 40,
        body:
          "Hello Ryder, we have submitted the closure for the empty rollover IRA. It will drop off your " +
          "statements from the next cycle; the account history stays available in the portal.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_ethan",
        atMin: 290,
        body: `${INTERNAL_MARK}: custodian confirms the account is closed with a zero balance. Resolving.`,
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },
  {
    ref: "OPS-11",
    category: "BENEFICIARY_TOD",
    status: "PENDING_CLIENT",
    createdMinAgo: 900,
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    subject: "Add contingent beneficiaries to the TOD registration",
    description:
      "Client wants two contingent beneficiaries added to the transfer-on-death registration on the " +
      "taxable account. Primary beneficiary is unchanged; the shares should split evenly between the " +
      "two contingents.",
    clientReference: "Friesen household · joint taxable",
    requesterName: "Bryon Friesen",
    requesterEmail: "bryon.friesen@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_marco",
        atMin: 150,
        body:
          "Hello Bryon, we have prepared the updated TOD form with your two contingent beneficiaries at an " +
          "even split. It is waiting for your signature; once it comes back we will file it with the " +
          "custodian and send you the confirmation.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 155,
        body: `${INTERNAL_MARK}: the contingent shares must total one hundred percent or the custodian rejects the form.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 700,
        body: `${INTERNAL_MARK}: form still unsigned; reminder scheduled with the advisor's next check-in.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "OPS-12",
    category: "RETURNED_CHECK",
    status: "OPEN",
    createdMinAgo: 470,
    createdById: "staff_marco",
    assigneeId: "staff_marco",
    // the unresponsive-client cadence, set by the desk once the check was voided and held.
    // Two days out, so the ticket reads as "due" rather than overdue.
    followUpInMin: 2 * 24 * 60,
    flaggedAtMin: 55,
    subject: "Distribution check returned by the post office",
    description:
      "The quarterly distribution check came back undeliverable. The address on the custodian record " +
      "looks correct, so the return is more likely a forwarding lapse. Confirm the address with the " +
      "client, then reissue.",
    clientReference: "Crooks household · traditional IRA",
    requesterName: "Leone Crooks",
    requesterEmail: "leone.crooks@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_marco",
        atMin: 50,
        body:
          "Hello Leone, your distribution check was returned to us as undeliverable. Before we reissue it, " +
          "please confirm the mailing address you would like us to use. We can also send future " +
          "distributions electronically to the bank account already on file.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_ethan",
        atMin: 55,
        body: `${INTERNAL_MARK}: check is voided and held at the desk; do not reissue until the address is confirmed in writing.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "WARNING" },
  },
  {
    ref: "OPS-13",
    category: "RETIREMENT_DISTRIBUTION",
    status: "PENDING_INTERNAL",
    createdMinAgo: 100,
    createdById: "staff_rachel",
    assigneeId: "staff_ethan",
    subject: "Remaining RMD for the year, withholding at the federal default",
    description:
      "Client has taken part of this year's required minimum distribution and wants the remainder paid " +
      "before year end, with federal withholding at the default rate and no state withholding.",
    clientReference: "Rice household · traditional IRA",
    requesterName: "Stacey Rice",
    requesterEmail: "stacey.rice@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_ethan",
        atMin: 45,
        body:
          "Hello Stacey, we have your instruction for the remaining distribution with federal withholding at " +
          "the default rate and no state withholding. We are confirming the remaining amount with the " +
          "custodian and will send you the figure before anything is paid.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_rachel",
        atMin: 50,
        body: `${INTERNAL_MARK}: waiting on the custodian's year-to-date figure before we release the balance of the distribution.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "OPS-14",
    category: "COST_BASIS",
    status: "RESOLVED",
    createdMinAgo: 2000,
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    resolvedAtMin: 900,
    // Wave A the advisor platform pointers — opaque ids only, never account numbers.
    householdId: "reichert",
    requesterExternalId: "reichert-mylene",
    subject: "Transferred lots showing zero cost basis after the ACAT",
    description:
      "Positions that transferred in last month show a zero basis in the portal, so the unrealized gain " +
      "looks far too large. The delivering firm sends its basis file after the assets; confirm it arrived " +
      "and reconcile the lots.",
    clientReference: "Reichert household · individual",
    requesterName: "Mylene Reichert",
    requesterEmail: "mylene.reichert@example.com",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 30,
        body: `${INTERNAL_MARK}: basis file from the delivering firm lands a few days behind the assets; check the overnight feed.`,
      },
      {
        visibility: "PUBLIC",
        authorId: "staff_marco",
        atMin: 200,
        body:
          "Hello Mylene, the zero cost basis you are seeing is because the delivering firm sends its basis " +
          "records separately from the positions themselves. The file has now arrived and we are applying " +
          "it lot by lot; your gain figures will look correct once that finishes.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 880,
        body: `${INTERNAL_MARK}: every transferred lot now carries an acquisition date and basis; reconciled against the delivering firm's file. Resolving.`,
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },

  // ----- CLIENT_SERVICE, Wave A categories -----
  {
    ref: "CS-09",
    category: "RETURNED_MAIL",
    status: "OPEN",
    createdMinAgo: 600,
    createdById: "staff_helen",
    assigneeId: "staff_jordan",
    subject: "Statement envelope returned — no forwarding order",
    description:
      "The printed statement came back marked undeliverable with no forwarding order. The client has not " +
      "reported a move, so confirm the address and offer electronic delivery.",
    clientReference: "Nikolaus household",
    requesterName: "Emory Nikolaus",
    requesterEmail: "emory.nikolaus@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_jordan",
        atMin: 120,
        body:
          "Hello Emory, your most recent statement came back to us undeliverable. Could you confirm the " +
          "mailing address we should use? If it is easier, we can switch you to electronic statements and " +
          "you will get them the day they are ready.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 125,
        body: `${INTERNAL_MARK}: mail delivery suppressed for this household until an address is confirmed, so nothing else bounces.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "CS-10",
    category: "PASSKEY_LOGIN",
    status: "RESOLVED",
    createdMinAgo: 1500,
    createdById: "staff_helen",
    assigneeId: "staff_helen",
    resolvedAtMin: 90,
    // the only fixture that did not arrive on a staff form. CEDAR_RIDGE_DIRECT is the digital brand,
    // so the reply goes out under that identity and its disclaimer variant.
    brand: "CEDAR_RIDGE_DIRECT",
    source: "EMAIL",
    externalId: "<passkey-enrollment-thread@mail.example.com>",
    subject: "Passkey stopped working after replacing the phone",
    description:
      "Client replaced their phone and the saved passkey did not carry across, so sign-in fails at the " +
      "passkey prompt. They still have access to the email address on the account.",
    clientReference: "O'Hara household",
    requesterName: "Leonardo O'Hara",
    requesterEmail: "leonardo.ohara@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_helen",
        atMin: 25,
        body:
          "Hello Leonardo, a passkey is tied to the device that created it, so a new phone needs a new one. We " +
          "have cleared the old passkey from your profile; the next time you sign in you will be offered " +
          "the option to enroll this phone.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 30,
        body: `${INTERNAL_MARK}: old credential removed after confirming the request came from the address on the account.`,
      },
      {
        visibility: "PUBLIC",
        authorId: "staff_helen",
        atMin: 85,
        body: "Hello Leonardo, we can see the new passkey enrolled successfully. Nothing further is needed on your side.",
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },
  {
    ref: "CS-11",
    category: "IDENTITY_VERIFICATION",
    status: "PENDING_CLIENT",
    createdMinAgo: 300,
    createdById: "staff_jordan",
    assigneeId: "staff_jordan",
    subject: "Identity documents needed before the profile change takes effect",
    description:
      "Client asked to change the legal name on the account after a marriage. The custodian needs a " +
      "government identity document and the marriage certificate before the registration can be updated.",
    clientReference: "Herman household",
    requesterName: "Merlin Herman",
    requesterEmail: "merlin.herman@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_jordan",
        atMin: 30,
        body:
          "Hello Merlin, congratulations. To update the name on your account we need a government-issued " +
          "identity document in the new name and a copy of the marriage certificate. Please upload them " +
          "through the secure documents area rather than by email.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_priya",
        atMin: 35,
        body: `${INTERNAL_MARK}: name change is a registration change, so the identity evidence has to be on file before it is submitted.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 200,
        body: `${INTERNAL_MARK}: nothing uploaded yet; leaving the ticket with the client rather than chasing the custodian.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    ref: "CS-12",
    category: "COMPLAINT",
    status: "OPEN",
    createdMinAgo: 95,
    createdById: "staff_helen",
    assigneeId: "staff_helen",
    // Cedar Ridge files a complaint record even when the matter is self-resolved.
    // The flags are applied at +10 m, the way a staff member flags an intake they have just read.
    isComplaint: true,
    escalationTarget: "COMPLIANCE",
    flaggedAtMin: 10,
    subject: "Client says a distribution request was ignored for a week",
    description:
      "Client writes that their distribution request went unanswered for a week and that nobody returned " +
      "their calls. They are asking for a written explanation of what happened.",
    clientReference: "Murray household · rollover IRA",
    requesterName: "Alek Murray",
    requesterEmail: "alek.murray@example.com",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 12,
        body: `${INTERNAL_MARK}: flagged as a complaint and escalated to compliance. Do not close this without their sign-off.`,
      },
      {
        visibility: "PUBLIC",
        authorId: "staff_helen",
        atMin: 20,
        body:
          "Hello Alek, thank you for telling us. I am sorry your request sat without an answer and that your " +
          "calls were not returned. We are reviewing what happened and you will have a written explanation " +
          "from us, along with the status of the distribution itself.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_priya",
        atMin: 60,
        body: `${INTERNAL_MARK}: complaint record opened; pulling the call log and the ticket history for the review file.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "WARNING" },
  },
  {
    ref: "CS-13",
    category: "VOICEMAIL_CALLBACK",
    status: "NEW",
    createdMinAgo: 45,
    createdById: "staff_helen",
    // a voicemail has a number and no address. requesterEmail is deliberately
    // null here — this is the fixture that proves the DB CHECK is satisfied by the phone alone, and
    // that the client API's requester-equality check denies a null address.
    requesterEmail: null,
    requesterPhone: "+12065550140",
    source: "VOICEMAIL",
    externalId: "phone-system-voicemail:crw-8812",
    subject: "Voicemail from Willie Walker — asking about a transfer",
    description:
      "Voicemail transcript: caller asks whether the transfer she signed for last week has started, and " +
      "would like a call back this afternoon. No account was named on the message.\n\n" +
      "Caller left a number for the callback: +1 512-555-0147.",
    clientReference: "Walker household",
    requesterName: "Willie Walker",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 5,
        body: `${INTERNAL_MARK}: no email on this one, so the callback number is the only way to reach her — do not reply by mail.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 30,
        body: `${INTERNAL_MARK}: matched the caller to the household by the number on file; the transfer is the one opened last week.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "WARNING" },
  },
  {
    ref: "CS-14",
    category: "STATEMENT_REQUEST",
    status: "CLOSED",
    createdMinAgo: 3 * 24 * 60,
    createdById: "staff_helen",
    assigneeId: "staff_jordan",
    resolvedAtMin: 600,
    closedAtMin: 2880,
    subject: "Copies of last year's statements for a mortgage application",
    description:
      "Client's lender is asking for twelve months of account statements. They would like them as a " +
      "single download rather than month by month.",
    clientReference: "Mayer household · individual",
    requesterName: "Kamron Mayer",
    requesterEmail: "kamron.mayer@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_jordan",
        atMin: 180,
        body:
          "Hello Kamron, we can pull those together for you. Statements are available in the Documents area " +
          "of the portal, and we will also prepare a single combined file covering the twelve months your " +
          "lender asked for.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_jordan",
        atMin: 185,
        body: `${INTERNAL_MARK}: combined statement file goes to the portal, not to the lender — we do not send client records to third parties.`,
      },
      {
        visibility: "PUBLIC",
        authorId: "staff_jordan",
        atMin: 560,
        body:
          "Hello Kamron, the combined statement file is in your Documents area now. You can download it and " +
          "pass it to your lender yourself.",
      },
    ],
    expectSla: { phase: "COMPLETE", status: "MET" },
  },
  {
    ref: "CS-15",
    category: "VOICEMAIL_CALLBACK",
    status: "OPEN",
    createdMinAgo: 130,
    createdById: "staff_jordan",
    assigneeId: "staff_helen",
    // The ordinary case: a returned call where we hold both a number and an address. CS-13 above is
    // the phone-only one, so the contrast between the two is visible in the fixtures.
    requesterPhone: "+16175550147",
    source: "PHONE",
    subject: "Callback request after a missed call from the service desk",
    description:
      "Client returned our missed call and asked to be called back about the paperwork we sent. They are " +
      "reachable on the mobile number on file for the rest of the afternoon.",
    clientReference: "Harvey household",
    requesterName: "Obie Harvey",
    requesterEmail: "obie.harvey@example.com",
    comments: [
      {
        visibility: "PUBLIC",
        authorId: "staff_helen",
        atMin: 55,
        body:
          "Hello Obie, thank you for calling back. I have left you a voicemail with what we need on the " +
          "paperwork, and I will try you again this afternoon on the mobile number we have on file.",
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 60,
        body: `${INTERNAL_MARK}: reached voicemail on the first attempt; trying again after three.`,
      },
    ],
    expectSla: { phase: "RESOLUTION", status: "ON_TRACK" },
  },
  {
    // --- Wave B: the VOIDED fixture. ---
    //
    // The realistic case, not a synthetic one: a duplicate opened by a second associate on the same
    // call. It carries INTERNAL notes and NO public reply — the desk never wrote to the client from
    // it — which is exactly the precondition `voidTicket` enforces, and it is why a void is available
    // here where a correction would be the answer once a reply existed.
    //
    // It also seeds the negative half of Decision #96: the dashboard counters, the SLA sweep, the
    // reporting suite and the CSV export must all EXCLUDE it, and a seeded database is the cheapest
    // place to notice a surface that forgot to.
    ref: "OPS-15",
    category: "ACAT",
    status: "VOIDED",
    // Five hours old against a 240-minute first-response clock, so it is BREACHED on the raw timers.
    // That is deliberate: if any counter, sweep, report or export forgets `METRICS_EXCLUDED_STATUSES`,
    // a seeded database shows it immediately as a breach nobody can act on.
    createdMinAgo: 300,
    createdById: "staff_helen",
    subject: "Transfer from Edward Jones — statement received",
    description:
      "Client called about an incoming transfer and mentioned the statement is already uploaded. Opened " +
      "while Operations was on the phone with the same client about the same transfer.",
    clientReference: "Okafor household · joint taxable",
    requesterName: "Kofi Okafor",
    requesterEmail: "kofi.okafor@example.com",
    voidedAtMin: 35,
    voidedById: "staff_marco",
    voidReason: "Duplicate of the ticket Operations opened on the same call; nothing was sent from this one.",
    comments: [
      {
        visibility: "INTERNAL",
        authorId: "staff_helen",
        atMin: 5,
        body: `${INTERNAL_MARK}: opened from the CS line while Ops had the client on the other call — check before working this.`,
      },
      {
        visibility: "INTERNAL",
        authorId: "staff_marco",
        atMin: 30,
        body: `${INTERNAL_MARK}: confirmed duplicate. Voiding this one; the live ticket has the statement and the control number.`,
      },
    ],
    expectSla: { phase: "FIRST_RESPONSE", status: "BREACHED" },
  },
];

/**
 * The shape of the list above, asserted before anything is written. Two numbers rather than one
 * "8 per queue": Wave A's eleven categories route to Operations and Client Service only (ROUTING_TABLE),
 * so an even split would mean inventing Advice tickets for categories Advice does not work.
 */
const EXPECTED_FIXTURE_COUNT = 38;
const EXPECTED_FIXTURES_PER_QUEUE: Readonly<Record<QueueKey, number>> = {
  OPERATIONS: 15,
  CLIENT_SERVICE: 15,
  ADVICE: 8,
};

/** E.164 as prisma/schema.prisma documents `Ticket.requesterPhone`: `+`, a 1-9, then 7..14 more digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

// ---------------------------------------------------------------------------
// Persona reads: views, previews, one denial
// ---------------------------------------------------------------------------

type ViewFixture = { persona: StaffId; ticketRef: string; mode: "DETAIL" | "PREVIEW" };

const VIEW_FIXTURES: readonly ViewFixture[] = [
  { persona: "staff_marco", ticketRef: "OPS-01", mode: "DETAIL" },
  { persona: "staff_marco", ticketRef: "OPS-02", mode: "DETAIL" },
  { persona: "staff_sam", ticketRef: "OPS-05", mode: "PREVIEW" },
  { persona: "staff_helen", ticketRef: "CS-01", mode: "DETAIL" },
  { persona: "staff_helen", ticketRef: "CS-05", mode: "PREVIEW" },
  { persona: "staff_rachel", ticketRef: "ADV-01", mode: "DETAIL" },
  { persona: "staff_rachel", ticketRef: "ADV-05", mode: "PREVIEW" },
  { persona: "staff_priya", ticketRef: "CS-04", mode: "DETAIL" },
];

/** cs persona attempting ticket:read on an Advice ticket (client_services has no access to ADVICE). */
const DENIED_FIXTURE: { persona: StaffId; ticketRef: string; what: string } = {
  persona: "staff_helen",
  ticketRef: "ADV-01",
  what: "ticket:read DETAIL",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class SeedAssertionError extends Error {
  constructor(message: string) {
    super(`seed assertion failed: ${message}`);
    this.name = "SeedAssertionError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SeedAssertionError(message);
}

/** Minimal placeholder rendering for macro bodies (the app renders client-side via S3's macro-template). */
function renderTemplate(
  body: string,
  vars: { ticketNumber: number; requesterName: string; agentName: string; today: Date },
): string {
  const firstName = vars.requesterName.trim().split(/\s+/)[0] ?? vars.requesterName;
  return body
    .replaceAll("{{ticket.number}}", `HD-${vars.ticketNumber}`)
    .replaceAll("{{requester.name}}", vars.requesterName)
    .replaceAll("{{requester.firstName}}", firstName)
    .replaceAll("{{agent.name}}", vars.agentName)
    .replaceAll("{{today}}", formatDate(vars.today, "MMMM d, yyyy"));
}

/** NEW → … → target, using only ALLOWED_STATUS_TRANSITIONS edges. */
function statusChainTo(target: TicketStatus): TicketStatus[] {
  const chains: Record<TicketStatus, TicketStatus[]> = {
    NEW: [],
    OPEN: ["OPEN"],
    PENDING_CLIENT: ["OPEN", "PENDING_CLIENT"],
    PENDING_INTERNAL: ["OPEN", "PENDING_INTERNAL"],
    RESOLVED: ["OPEN", "RESOLVED"],
    CLOSED: ["OPEN", "RESOLVED", "CLOSED"],
    // VOIDED is NOT reachable through ALLOWED_STATUS_TRANSITIONS, so a voided
    // fixture walks the ordinary chain and `seedTicket` applies the void as its own step, exactly as
    // `voidTicket` does at runtime.
    VOIDED: [],
  };
  const chain = chains[target];
  let prev: TicketStatus = "NEW";
  for (const next of chain) {
    assert(canTransition(prev, next), `status chain ${prev} → ${next} is not an allowed transition`);
    prev = next;
  }
  return chain;
}

function assertPii(
  label: string,
  result: { redacted: boolean; byKind: Record<PiiKind, number> },
  expectation: PiiExpectation | undefined,
  redactedFields?: readonly string[],
): void {
  if (!expectation) return;
  assert(result.redacted === expectation.redacted, `${label}: expected redacted=${expectation.redacted}, got ${result.redacted}`);
  for (const kind of expectation.kinds ?? []) {
    assert(result.byKind[kind] >= 1, `${label}: expected at least one ${kind} redaction, got ${result.byKind[kind]}`);
  }
  if (expectation.fields && redactedFields) {
    for (const field of expectation.fields) {
      assert(redactedFields.includes(field), `${label}: expected field "${field}" to be redacted`);
    }
  }
}

type MacroRow = {
  id: string;
  key: string;
  queueId: string | null;
  body: string;
  channel: CommentVisibility;
  disclaimerKey: DisclaimerKey;
  isActive: boolean;
};

type SeedRefs = {
  /** The caller's transaction: every read and write of the seed goes through it. */
  db: DbTx;
  now: Date;
  /** The desk's last working moment and when the first visitor is likely to look (src/lib/demo/universe.ts). */
  close: Date;
  viewStart: Date;
  users: Map<StaffId, UserRow>;
  queueIds: Record<QueueKey, string>;
  macros: Map<string, MacroRow>;
  policies: Map<TicketPriority, SlaPolicyInput>;
  attachments: Map<string, DemoAttachment>;
  /** HD number per fixture ref, assigned in creation order around the stories' fixed numbers. */
  numbers: Map<string, number>;
};

/**
 * The source wrote each ticket and each Wave B group in a transaction of its own. Here they all join the
 * caller's one transaction, so a reset that fails halfway leaves yesterday's desk in place; each group
 * still ends in its own audit batch.
 */
function inSeedTx<T>(refs: SeedRefs, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return fn(refs.db);
}

function requireUser(refs: SeedRefs, id: StaffId): UserRow {
  const u = refs.users.get(id);
  assert(u, `unknown staff id ${id}`);
  return u;
}

function requireMacro(refs: SeedRefs, key: string): MacroRow {
  const m = refs.macros.get(key);
  assert(m, `macro "${key}" not found — run the reference seed first`);
  return m;
}

/**
 * Pre-flight: every permission, macro and timing rule the app would enforce, checked before any write —
 * over the hand-written tickets, the universe's stories and the generated history alike.
 */
function validateFixtures(refs: SeedRefs, fixtures: readonly TicketFixture[]): void {
  assert(
    TICKET_FIXTURES.length === EXPECTED_FIXTURE_COUNT,
    `expected ${EXPECTED_FIXTURE_COUNT} ticket fixtures, found ${TICKET_FIXTURES.length}`,
  );
  const refsSeen = new Set<string>();
  const externalIdsSeen = new Set<string>();
  const perQueue: Record<QueueKey, number> = { OPERATIONS: 0, CLIENT_SERVICE: 0, ADVICE: 0 };
  const categories = new Set<TicketCategory>();
  const priorities = new Set<TicketPriority>();
  const statuses = new Set<TicketStatus>();
  const macrosUsed = new Map<string, string>();

  for (const f of TICKET_FIXTURES) perQueue[routeCategory(f.category).queueKey]++;
  const numbersSeen = new Set<number>();
  for (const f of fixtures) {
    assert(!refsSeen.has(f.ref), `duplicate fixture ref ${f.ref}`);
    refsSeen.add(f.ref);
    if (f.number !== undefined) {
      assert(!numbersSeen.has(f.number), `${f.ref}: HD-${f.number} is taken twice`);
      numbersSeen.add(f.number);
    }
    const routed = routeCategory(f.category);
    const queueKey = routed.queueKey;
    const priority = f.priority ?? routed.priority;
    categories.add(f.category);
    priorities.add(priority);
    statuses.add(f.status);

    const creator = requireUser(refs, f.createdById);
    assert(creator.isActive && canCreateTicket(creator.groups, queueKey), `${f.ref}: ${f.createdById} cannot create in ${queueKey}`);
    if (f.assigneeId) {
      const assignee = requireUser(refs, f.assigneeId);
      assert(assignee.isActive && canWriteQueue(assignee.groups, queueKey), `${f.ref}: ${f.assigneeId} is not assignable in ${queueKey}`);
    }
    statusChainTo(f.status);

    // the void triple travels together, the reason is a sentence, the voider is
    // ops_team with WRITE on the queue, and a voided ticket has NO public reply — once the desk has
    // written to the client, the ticket is correspondence and the answer is a correction, not a void.
    const voidedFields = [f.voidedAtMin, f.voidedById, f.voidReason].filter((v) => v !== undefined).length;
    assert(
      (f.status === "VOIDED" && voidedFields === 3) || (f.status !== "VOIDED" && voidedFields === 0),
      `${f.ref}: voidedAtMin / voidedById / voidReason are set exactly for a VOIDED ticket`,
    );
    if (f.status === "VOIDED") {
      const voider = requireUser(refs, f.voidedById as StaffId);
      assert(
        voider.isActive && voider.groups.includes("ops_team") && canWriteQueue(voider.groups, queueKey),
        `${f.ref}: ${f.voidedById} may not void a ticket in ${queueKey} (ops_team + queue WRITE)`,
      );
      assert((f.voidReason ?? "").trim().length >= 12, `${f.ref}: a void reason is at least 12 characters`);
      assert(
        f.voidedAtMin !== undefined && f.voidedAtMin >= 0 && f.voidedAtMin < f.createdMinAgo,
        `${f.ref}: voidedAtMin +${f.voidedAtMin}m is in the future`,
      );
      assert(
        f.comments.every((c) => c.visibility === "INTERNAL"),
        `${f.ref}: a VOIDED ticket may not carry a PUBLIC reply`,
      );
    }

    const isResolved = f.status === "RESOLVED" || f.status === "CLOSED";
    assert(isResolved === (f.resolvedAtMin !== undefined), `${f.ref}: resolvedAtMin must be set exactly for RESOLVED/CLOSED`);
    assert((f.status === "CLOSED") === (f.closedAtMin !== undefined), `${f.ref}: closedAtMin must be set exactly for CLOSED`);
    if (f.resolvedAtMin !== undefined) assert(f.resolvedAtMin < f.createdMinAgo, `${f.ref}: resolvedAt is in the future`);
    if (f.closedAtMin !== undefined && f.resolvedAtMin !== undefined) {
      assert(f.closedAtMin >= f.resolvedAtMin && f.closedAtMin < f.createdMinAgo, `${f.ref}: closedAt out of range`);
    }

    // --- Wave A columns, checked with the app's own rules before Postgres gets the chance ---
    // DB CHECK `ticket_requester_contact_present`, refused here with a readable message.
    assert(
      f.requesterEmail !== null || f.requesterPhone !== undefined,
      `${f.ref}: a ticket must carry a requesterEmail or a requesterPhone`,
    );
    if (f.requesterPhone !== undefined) {
      assert(E164.test(f.requesterPhone), `${f.ref}: requesterPhone ${f.requesterPhone} is not E.164`);
    }
    if (f.externalId !== undefined) {
      // @@unique([source, externalId]) — a fixture may not collide with another on the same channel.
      const key = `${f.source ?? "STAFF_FORM"}\u0000${f.externalId}`;
      assert(!externalIdsSeen.has(key), `${f.ref}: duplicate (source, externalId) ${key.replace("\u0000", " / ")}`);
      externalIdsSeen.add(key);
    }
    const flagged = f.isComplaint !== undefined || f.escalationTarget !== undefined || f.followUpInMin !== undefined;
    assert(flagged === (f.flaggedAtMin !== undefined), `${f.ref}: flaggedAtMin must be set exactly when a flag is`);
    if (f.flaggedAtMin !== undefined) {
      assert(f.flaggedAtMin >= 0 && f.flaggedAtMin < f.createdMinAgo, `${f.ref}: flaggedAtMin +${f.flaggedAtMin}m is in the future`);
    }
    // escalation is a pointer, not a state — NONE is the default and never a "change".
    if (f.escalationTarget !== undefined) {
      assert(f.escalationTarget !== "NONE", `${f.ref}: escalationTarget NONE is the default, not a flag`);
    }

    // A story ticket nobody has picked up yet (HD-2476) has no thread at all; every other ticket has one.
    const minComments = f.number !== undefined && f.status === "NEW" ? 0 : 2;
    assert(
      f.comments.length >= minComments && f.comments.length <= 5,
      `${f.ref}: expected ${minComments}–5 comments, found ${f.comments.length}`,
    );
    for (const a of f.attachments ?? []) {
      const uploader = requireUser(refs, a.uploaderId);
      assert(uploader.isActive && canWriteQueue(uploader.groups, queueKey), `${f.ref}: ${a.uploaderId} may not attach in ${queueKey}`);
      assert(refs.attachments.has(a.id), `${f.ref}: unknown seeded attachment ${a.id}`);
      assert(a.atMin >= 0 && a.atMin < f.createdMinAgo, `${f.ref}: attachment at +${a.atMin}m is in the future`);
    }
    let hasPublic = false;
    for (const c of f.comments) {
      const author = requireUser(refs, c.authorId);
      assert(author.isActive, `${f.ref}: comment author ${c.authorId} is inactive`);
      assert(canComment(author.groups, queueKey, c.visibility), `${f.ref}: ${c.authorId} may not add a ${c.visibility} comment in ${queueKey}`);
      assert(c.atMin >= 0 && c.atMin < f.createdMinAgo, `${f.ref}: comment at +${c.atMin}m is in the future`);
      assert((c.body === undefined) !== (c.macroKey === undefined), `${f.ref}: a comment has exactly one of body / macroKey`);
      if (c.macroKey) {
        const macro = requireMacro(refs, c.macroKey);
        assert(macro.isActive, `${f.ref}: macro ${c.macroKey} is inactive`);
        assert(macro.channel === c.visibility, `${f.ref}: macro ${c.macroKey} channel ${macro.channel} ≠ ${c.visibility}`);
        assert(macro.queueId === null || macro.queueId === refs.queueIds[queueKey], `${f.ref}: macro ${c.macroKey} is not available in ${queueKey}`);
        assert(!macrosUsed.has(c.macroKey), `${f.ref}: macro ${c.macroKey} already used by ${macrosUsed.get(c.macroKey)} (one ticket per macro)`);
        macrosUsed.set(c.macroKey, f.ref);
      }
      if (c.visibility === "PUBLIC") {
        hasPublic = true;
        if (f.resolvedAtMin !== undefined) assert(c.atMin <= f.resolvedAtMin, `${f.ref}: public reply after resolution`);
      } else if (c.body !== undefined) {
        assert(c.body.includes(INTERNAL_MARK), `${f.ref}: INTERNAL bodies must include "${INTERNAL_MARK}"`);
      }
    }
    // The first PUBLIC reply auto-opens a NEW ticket, so a NEW fixture cannot carry one.
    if (f.status === "NEW") assert(!hasPublic, `${f.ref}: a NEW ticket cannot have a PUBLIC reply`);
  }

  for (const q of Object.keys(perQueue) as QueueKey[]) {
    assert(
      perQueue[q] === EXPECTED_FIXTURES_PER_QUEUE[q],
      `expected ${EXPECTED_FIXTURES_PER_QUEUE[q]} tickets in ${q}, found ${perQueue[q]}`,
    );
  }
  for (const c of TICKET_CATEGORIES) assert(categories.has(c), `category ${c} is not covered`);
  for (const p of TICKET_PRIORITIES) assert(priorities.has(p), `priority ${p} is not covered`);
  for (const s of TICKET_STATUSES) assert(statuses.has(s), `status ${s} is not covered`);
  assert(macrosUsed.size === refs.macros.size, `expected every macro to be applied once (${macrosUsed.size}/${refs.macros.size})`);

  for (const v of VIEW_FIXTURES) {
    const persona = requireUser(refs, v.persona);
    const target = TICKET_FIXTURES.find((t) => t.ref === v.ticketRef);
    assert(target, `view fixture references unknown ticket ${v.ticketRef}`);
    assert(canReadQueue(persona.groups, routeCategory(target.category).queueKey), `${v.persona} cannot read ${v.ticketRef}`);
  }
  const deniedPersona = requireUser(refs, DENIED_FIXTURE.persona);
  const deniedTarget = TICKET_FIXTURES.find((t) => t.ref === DENIED_FIXTURE.ticketRef);
  assert(deniedTarget, `denied fixture references unknown ticket ${DENIED_FIXTURE.ticketRef}`);
  assert(!canReadQueue(deniedPersona.groups, routeCategory(deniedTarget.category).queueKey), `denied fixture: ${DENIED_FIXTURE.persona} can actually read ${DENIED_FIXTURE.ticketRef}`);
}

// ---------------------------------------------------------------------------
// One ticket = one transaction; writeAuditMany is the last statement
// ---------------------------------------------------------------------------

type SeededTicket = { ref: string; id: string; number: number; piiRedactionCount: number; slaAtView: { phase: SlaPhase; status: SlaStatus } };

async function seedTicket(f: TicketFixture, refs: SeedRefs): Promise<SeededTicket> {
  const number = refs.numbers.get(f.ref);
  assert(number !== undefined, `${f.ref}: no HD number assigned`);
  const { now } = refs;
  const routed = routeCategory(f.category);
  const queueKey = routed.queueKey;
  const priority = f.priority ?? routed.priority;
  const createdAt = subMinutes(now, f.createdMinAgo);
  const creator = requireUser(refs, f.createdById);
  const assignee = f.assigneeId ? requireUser(refs, f.assigneeId) : null;
  const statusChain = statusChainTo(f.status);
  const ctx = systemRequestContext("seed");

  // I4: sanitize every persisted string BEFORE the write (same four fields as createTicket).
  const fields = sanitizeFields({
    subject: f.subject,
    description: f.description,
    clientReference: f.clientReference ?? null,
    requesterName: f.requesterName,
  });
  assertPii(`${f.ref} ticket fields`, fields, f.expectPii, fields.redactedFields);
  const subject = fields.values.subject ?? f.subject;
  const description = fields.values.description ?? f.description;
  const clientReference = fields.values.clientReference ?? null;
  const requesterName = fields.values.requesterName ?? f.requesterName;

  const requesterEmail = f.requesterEmail === null ? null : f.requesterEmail.toLowerCase();
  const resolvedAt = f.resolvedAtMin === undefined ? null : addMinutes(createdAt, f.resolvedAtMin);
  const closedAt = f.closedAtMin === undefined ? null : addMinutes(createdAt, f.closedAtMin);
  // Wave A flags are a staff action at +flaggedAtMin, not an intake attribute: the ticket is created
  // at its column defaults and updated once, the way updateTicketFields would have written them.
  const flaggedAt = f.flaggedAtMin === undefined ? null : addMinutes(createdAt, f.flaggedAtMin);
  const followUpAt = f.followUpInMin === undefined ? null : addMinutes(now, f.followUpInMin);

  return inSeedTx(refs, async (tx: DbTx) => {
    const policy = refs.policies.get(priority);
    assert(policy, `no SLA policy for ${priority}`);
    const due = computeDueDates(createdAt, policy);

    // Comments are prepared inside the transaction because macro bodies need the ticket number; the
    // ticket row itself is created first so the number exists, then updated once with the aggregates.
    const ticket = await tx.ticket.create({
      data: {
        // Readable, fixed ids: a seeded attachment's object key is known before the reset runs.
        id: demoTicketId(number),
        number,
        subject,
        description,
        clientReference,
        requesterName,
        requesterEmail,
        requesterPhone: f.requesterPhone ?? null,
        brand: f.brand ?? "CEDAR_RIDGE_WEALTH",
        source: f.source ?? "STAFF_FORM",
        externalId: f.externalId ?? null,
        externalRef: f.externalRef ?? null,
        householdId: f.householdId ?? null,
        requesterExternalId: f.requesterExternalId ?? null,
        category: f.category,
        priority,
        // a VOIDED ticket is created in the status it was in BEFORE the void and transitioned
        // below, because VOIDED is not reachable through ALLOWED_STATUS_TRANSITIONS — `voidTicket`
        // writes that one edge itself, and the seed mirrors it rather than shortcutting.
        status: f.status === "VOIDED" ? "NEW" : f.status,
        queueId: refs.queueIds[queueKey],
        createdById: creator.id,
        assigneeId: assignee?.id ?? null,
        slaFirstResponseMinutes: policy.firstResponseMinutes,
        slaResolutionMinutes: policy.resolutionMinutes,
        firstResponseDueAt: due.firstResponseDueAt,
        resolutionDueAt: due.resolutionDueAt,
        resolvedAt,
        closedAt,
        piiRedacted: fields.redacted,
        piiRedactionCount: fields.count,
        createdAt,
        updatedAt: createdAt,
      },
      select: { id: true, number: true },
    });

    const entries: AuditEntry[] = [];
    entries.push({
      action: "TICKET_CREATED",
      entityType: "TICKET",
      entityId: ticket.id,
      ticketId: ticket.id,
      newValue: JSON.stringify({
        subject,
        category: f.category,
        priority,
        queueKey,
        requesterName,
        requesterEmail,
        assigneeId: assignee?.id ?? null,
      }),
    });
    if (priority !== routed.priority) {
      entries.push({
        action: "TICKET_PRIORITY_CHANGED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "priority",
        oldValue: routed.priority,
        newValue: priority,
      });
    }
    if (assignee) {
      entries.push({
        action: "TICKET_ASSIGNED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "assigneeId",
        oldValue: null,
        newValue: assignee.id,
        metadata: { oldEmail: null, newEmail: assignee.email },
      });
    }
    if (fields.redacted) {
      entries.push({
        action: "PII_REDACTED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: fields.redactedFields.join(","),
        oldValue: null,
        newValue: formatPiiCounts(fields.byKind),
      });
    }

    // Comments, chronologically.
    const ordered = [...f.comments].sort((a, b) => a.atMin - b.atMin);
    let firstRespondedAt: Date | null = null;
    let commentPiiCount = 0;
    let lastEventAt = createdAt;
    for (const c of ordered) {
      const author = requireUser(refs, c.authorId);
      const commentAt = addMinutes(createdAt, c.atMin);
      const macro = c.macroKey ? requireMacro(refs, c.macroKey) : null;
      const rawBody =
        macro !== null
          ? renderTemplate(macro.body, {
              ticketNumber: ticket.number,
              requesterName,
              agentName: author.name ?? author.email,
              today: commentAt,
            })
          : (c.body ?? "");
      const sanitized = sanitizePII(rawBody);
      assertPii(`${f.ref} comment +${c.atMin}m`, sanitized, c.expectPii);
      const disclaimerKey: DisclaimerKey =
        c.visibility === "PUBLIC" ? (c.disclaimerKey ?? macro?.disclaimerKey ?? routed.disclaimerKey) : "NONE";
      assert(c.visibility !== "PUBLIC" || disclaimerKey !== "NONE", `${f.ref}: a PUBLIC reply needs a disclaimer`);
      // I7: the disclaimer is appended AFTER sanitization and stored in the row (exactly what the client receives).
      const stored = c.visibility === "PUBLIC" ? appendDisclaimer(sanitized.text, disclaimerKey) : sanitized.text;

      const comment = await tx.comment.create({
        data: {
          ticketId: ticket.id,
          authorId: author.id,
          visibility: c.visibility,
          body: stored,
          disclaimerKey,
          macroId: macro?.id ?? null,
          piiRedacted: sanitized.redacted,
          piiRedactionCount: sanitized.count,
          createdAt: commentAt,
        },
        select: { id: true },
      });
      commentPiiCount += sanitized.count;
      if (commentAt > lastEventAt) lastEventAt = commentAt;

      entries.push({
        action: c.visibility === "PUBLIC" ? "COMMENT_ADDED_PUBLIC" : "COMMENT_ADDED_INTERNAL",
        entityType: "COMMENT",
        entityId: comment.id,
        ticketId: ticket.id,
        fieldChanged: "body",
        oldValue: null,
        newValue: stored,
        metadata: c.visibility === "PUBLIC" ? { disclaimerKey } : undefined,
      });
      if (macro) {
        entries.push({
          action: "MACRO_APPLIED",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "macroId",
          oldValue: null,
          newValue: macro.key,
        });
      }
      if (sanitized.redacted) {
        entries.push({
          action: "PII_REDACTED",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: formatPiiCounts(sanitized.byKind),
        });
      }
      // Only the first PUBLIC reply stamps firstRespondedAt (I10 / §d).
      if (c.visibility === "PUBLIC" && firstRespondedAt === null) {
        firstRespondedAt = commentAt;
        entries.push({
          action: "TICKET_FIELD_CHANGED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "firstRespondedAt",
          oldValue: null,
          newValue: serializeAuditValue(commentAt),
        });
      }
    }

    // Seeded attachments: written as `finalizeUpload` leaves them (READY, size and digest verified),
    // with the same two ledger rows its intent and finalize steps write.
    for (const a of f.attachments ?? []) {
      const file = refs.attachments.get(a.id);
      assert(file && file.ticketNumber === ticket.number, `${f.ref}: attachment ${a.id} belongs to another ticket`);
      const uploader = requireUser(refs, a.uploaderId);
      const at = addMinutes(createdAt, a.atMin);
      await tx.attachment.create({
        data: {
          id: file.id,
          ticketId: ticket.id,
          uploaderId: uploader.id,
          kind: "UPLOAD",
          filename: file.filename,
          mime: file.mime,
          size: file.bytes.length,
          sha256: file.sha256,
          objectKey: file.objectKey,
          state: "READY",
          visibility: "INTERNAL",
          createdAt: at,
          readyAt: at,
        },
      });
      const facts = { filename: file.filename, mime: file.mime, size: file.bytes.length, backend: "filesystem" };
      entries.push(
        {
          action: "ATTACHMENT_INTENT_CREATED",
          entityType: "ATTACHMENT",
          entityId: file.id,
          ticketId: ticket.id,
          fieldChanged: "state",
          oldValue: null,
          newValue: "PENDING",
          metadata: { stage: "intent", ...facts },
        },
        {
          action: "ATTACHMENT_ADDED",
          entityType: "ATTACHMENT",
          entityId: file.id,
          ticketId: ticket.id,
          fieldChanged: "state",
          oldValue: "PENDING",
          newValue: "READY",
          metadata: { stage: "ready", ...facts, sha256Verified: true },
        },
      );
      if (at > lastEventAt) lastEventAt = at;
    }

    // Wave A flags. One staff edit → one TICKET_FIELD_CHANGED per field and a single
    // version bump, which is exactly what updateTicketFields writes; complaintFiledAt is stamped by
    // the server the first time isComplaint goes true and is never an input.
    const complaintFiledAt = f.isComplaint === true && flaggedAt !== null ? flaggedAt : null;
    const flagDiffs: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    if (f.isComplaint !== undefined) {
      flagDiffs.push({ field: "isComplaint", oldValue: "false", newValue: serializeAuditValue(f.isComplaint) });
      if (complaintFiledAt !== null) {
        flagDiffs.push({ field: "complaintFiledAt", oldValue: null, newValue: serializeAuditValue(complaintFiledAt) });
      }
    }
    if (f.escalationTarget !== undefined) {
      flagDiffs.push({ field: "escalationTarget", oldValue: "NONE", newValue: f.escalationTarget });
    }
    if (followUpAt !== null) {
      flagDiffs.push({ field: "followUpAt", oldValue: null, newValue: serializeAuditValue(followUpAt) });
    }
    if (flagDiffs.length > 0) {
      assert(flaggedAt !== null, `${f.ref}: flag changes need a flaggedAtMin`);
      if (flaggedAt > lastEventAt) lastEventAt = flaggedAt;
      for (const d of flagDiffs) {
        entries.push({
          action: "TICKET_FIELD_CHANGED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: d.field,
          oldValue: d.oldValue,
          newValue: d.newValue,
        });
      }
    }

    // Status chain to the current status.
    let prevStatus: TicketStatus = "NEW";
    for (const next of statusChain) {
      entries.push({
        action: "TICKET_STATUS_CHANGED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "status",
        oldValue: prevStatus,
        newValue: next,
      });
      prevStatus = next;
    }
    if (resolvedAt) {
      if (resolvedAt > lastEventAt) lastEventAt = resolvedAt;
      entries.push({
        action: "TICKET_FIELD_CHANGED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "resolvedAt",
        oldValue: null,
        newValue: serializeAuditValue(resolvedAt),
      });
    }
    if (closedAt) {
      if (closedAt > lastEventAt) lastEventAt = closedAt;
      entries.push({
        action: "TICKET_FIELD_CHANGED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "closedAt",
        oldValue: null,
        newValue: serializeAuditValue(closedAt),
      });
    }

    // the void, as its own edge, with its own action and its own three columns.
    let voidedAt: Date | null = null;
    let voidedById: string | null = null;
    let voidReason: string | null = null;
    if (f.status === "VOIDED") {
      voidedAt = addMinutes(createdAt, f.voidedAtMin as number);
      voidedById = requireUser(refs, f.voidedById as StaffId).id;
      voidReason = sanitizePII(f.voidReason as string).text;
      if (voidedAt > lastEventAt) lastEventAt = voidedAt;
      entries.push({
        action: "TICKET_VOIDED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "status",
        oldValue: prevStatus,
        newValue: "VOIDED",
        metadata: { reason: voidReason },
      });
      prevStatus = "VOIDED";
    }

    // Aggregates the app would have accumulated across the mutations above (I13: every change bumps version).
    const piiRedactionCount = fields.count + commentPiiCount;
    const version =
      1 + statusChain.length + ordered.length + (assignee ? 1 : 0) + (flagDiffs.length > 0 ? 1 : 0) + (voidedAt ? 1 : 0);
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        firstRespondedAt,
        ...(voidedAt
          ? { status: "VOIDED" as const, voidedAt, voidedById, voidReason, resolution: "ENTERED_IN_ERROR" as const }
          : {}),
        ...(f.isComplaint !== undefined ? { isComplaint: f.isComplaint } : {}),
        ...(complaintFiledAt !== null ? { complaintFiledAt } : {}),
        ...(f.escalationTarget !== undefined ? { escalationTarget: f.escalationTarget } : {}),
        ...(followUpAt !== null ? { followUpAt } : {}),
        piiRedacted: piiRedactionCount > 0,
        piiRedactionCount,
        version,
        updatedAt: lastEventAt,
      },
    });

    // SLA state the dashboard will show — asserted so the fixture matrix is provably present.
    const timers = { firstResponseDueAt: due.firstResponseDueAt, resolutionDueAt: due.resolutionDueAt, firstRespondedAt, resolvedAt };
    if (f.expectSla) {
      const at = f.slaAt === "VIEW" ? refs.viewStart : f.slaAt === "CLOSE" ? refs.close : now;
      const sla = computeSlaStatus(timers, at);
      assert(
        sla.phase === f.expectSla.phase && sla.status === f.expectSla.status,
        `${f.ref}: expected SLA ${f.expectSla.phase}/${f.expectSla.status} at ${f.slaAt ?? "SEED"}, computed ${sla.phase}/${sla.status}`,
      );
    }
    const atView = computeSlaStatus(timers, refs.viewStart);

    // I3: the audit batch is the LAST statement of this ticket's writes.
    await writeAuditMany(tx, SYSTEM_ACTOR, ctx, entries);
    return {
      ref: f.ref,
      id: ticket.id,
      number: ticket.number,
      piiRedactionCount,
      slaAtView: { phase: atView.phase, status: atView.status },
    };
  });
}

// ---------------------------------------------------------------------------
// Step 7b — one row in every Wave B table a reader can SEE
//
// The rule this satisfies: an enum value or a table that no fixture exercises is a surface nobody has
// ever looked at. Wave A's coverage assertions already force every TicketCategory, TicketPriority and
// TicketStatus to appear (which is what made the VOIDED fixture above mandatory rather than optional);
// this step does the same for the Wave B tables whose absence would leave a UI panel permanently
// empty on a freshly seeded database — a link, a retraction, a review stamp, a follower with the
// notification it produced, and a pair of suppressions (one live, one lifted).
//
// The two lists below are EXHAUSTIVE over the thirteen tables of CONTRACT §1.3: seeded here are
// `TicketLink`, `CommentRetraction`, `ReviewStamp`, `TicketFollower`, `Notification` and
// `RequesterSuppression`; the remaining seven are argued against immediately below. A table in
// neither list is the failure this step exists to prevent — it reads as a decision and is an
// oversight — so adding a fourteenth table means adding it to one of the two.
//
// Deliberately NOT seeded, and each for a reason: `ClientApiToken` and `WebhookEndpoint` hold
// credentials, and a seeded credential is a real credential on any machine that runs the seed;
// `PushSubscription` names a browser that does not exist; `WebhookDelivery` would claim an HTTP call
// that never happened; `IdentityVerification` would assert that somebody verified a client's identity,
// which is precisely the kind of statement a fixture must never fabricate; `ComposerDraft` is
// per-person scratch; `FollowUpNudge` is a job's dedupe ledger and is meaningless without the job.
// ---------------------------------------------------------------------------

/**
 * Writes one TicketLink, one CommentRetraction, one ReviewStamp, one TicketFollower with the
 * Notification the follow produced, one FORWARDED `SuspendedIntake` hold, and two
 * `RequesterSuppression` rows (one live, one lifted) — each with the audit rows its runtime path
 * would write, and each as the last statement of its own transaction (§3 rule 2).
 *
 * Returns the number of fixture GROUPS written, which the caller asserts against.
 */
async function seedWaveBFixtures(refs: SeedRefs, seeded: Map<string, SeededTicket>): Promise<number> {
  const ctx = systemRequestContext("seed");
  const opsUser = requireUser(refs, "staff_marco");
  const csUser = requireUser(refs, "staff_helen");
  const complianceUser = requireUser(refs, "staff_priya");
  let written = 0;

  // --- A link: the voided duplicate, pointing at the ticket that survived it. This is the pair the
  //     duplicate banner and the links panel exist for, and it is the honest shape — the void did not
  //     erase the ticket, it disowned it, and the link is how a reader gets from one to the other.
  const voided = seeded.get("OPS-15");
  const survivor = seeded.get("OPS-05");
  if (voided && survivor) {
    await inSeedTx(refs, async (tx) => {
      const link = await tx.ticketLink.create({
        data: {
          fromTicketId: voided.id,
          toTicketId: survivor.id,
          kind: "DUPLICATE_OF",
          note: "Opened on the same call; this one was voided.",
          createdById: opsUser.id,
        },
        select: { id: true },
      });
      await writeAuditMany(tx, personaActor(opsUser), ctx, [
        {
          action: "TICKET_LINK_ADDED",
          entityType: "TICKET_LINK",
          entityId: link.id,
          ticketId: voided.id,
          fieldChanged: "kind",
          oldValue: null,
          newValue: "DUPLICATE_OF",
          metadata: { toTicketNumber: survivor.number },
        },
      ]);
    });
    written += 1;
  }

  // --- A retraction: a PUBLIC reply the desk took back. The comment row is untouched — the
  //     overlay is what the client view reads, and `ClientVisibleComment` blanks the body at the
  //     DATABASE, so a seeded database also seeds the proof that the client path cannot reach it.
  const retractable = await refs.db.comment.findFirst({
    where: { visibility: "PUBLIC", authorKind: "STAFF", authorId: csUser.id, retraction: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, ticketId: true },
  });
  if (retractable) {
    await inSeedTx(refs, async (tx) => {
      const retraction = await tx.commentRetraction.create({
        data: {
          commentId: retractable.id,
          retractedById: csUser.id,
          reason: sanitizePII("Sent to the wrong thread; the same answer was re-sent on the correct ticket.").text,
        },
        select: { id: true, reason: true },
      });
      // A QUEUED delivery for a withdrawn comment must never leave. The dev seed writes no deliveries,
      // so this is a no-op here — it is written out because the RUNTIME path must do it and a fixture
      // that quietly skipped it would teach the wrong shape.
      const cancelled = await tx.messageDelivery.updateMany({
        where: { commentId: retractable.id, status: "QUEUED" },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      const entries: AuditEntry[] = [
        {
          action: "COMMENT_RETRACTED",
          entityType: "COMMENT",
          entityId: retractable.id,
          ticketId: retractable.ticketId,
          fieldChanged: "body",
          oldValue: null,
          newValue: "withdrawn",
          metadata: { reason: retraction.reason },
        },
      ];
      if (cancelled.count > 0) {
        entries.push({
          action: "MESSAGE_CANCELLED",
          entityType: "MESSAGE_DELIVERY",
          entityId: retractable.id,
          ticketId: retractable.ticketId,
          fieldChanged: "status",
          oldValue: "QUEUED",
          newValue: "CANCELLED",
        });
      }
      await writeAuditMany(tx, personaActor(csUser), ctx, entries);
    });
    written += 1;
  }

  // --- A review stamp: compliance approving a public reply. Annotation, never operation (§b rule 2).
  const reviewable = await refs.db.comment.findFirst({
    where: { visibility: "PUBLIC", authorKind: "STAFF", retraction: null, reviewStamps: { none: {} } },
    orderBy: { createdAt: "asc" },
    select: { id: true, ticketId: true },
  });
  if (reviewable) {
    await inSeedTx(refs, async (tx) => {
      const stamp = await tx.reviewStamp.create({
        data: {
          commentId: reviewable.id,
          reviewerId: complianceUser.id,
          verdict: "APPROVED",
          note: "Wording matches the approved macro; disclaimer present.",
        },
        select: { id: true },
      });
      await writeAuditMany(tx, personaActor(complianceUser), ctx, [
        {
          action: "REVIEW_STAMPED",
          entityType: "REVIEW_STAMP",
          entityId: stamp.id,
          ticketId: reviewable.ticketId,
          fieldChanged: "verdict",
          oldValue: null,
          newValue: "APPROVED",
        },
      ]);
    });
    written += 1;
  }

  // --- A follower, and the notification the next update on that ticket would produce. Both exist so
  //     the inbox is not empty on a fresh database, which is the only way anyone looks at it.
  const followed = seeded.get("OPS-01");
  if (followed) {
    await inSeedTx(refs, async (tx) => {
      const follower = await tx.ticketFollower.create({
        data: { ticketId: followed.id, userId: complianceUser.id, source: "MANUAL" },
        select: { id: true },
      });
      await tx.notification.create({
        data: {
          userId: complianceUser.id,
          kind: "FOLLOWED_UPDATE",
          actorId: opsUser.id,
          ticketId: followed.id,
          preview: sanitizePII(`HD-${followed.number} — status changed while you were following it`).text,
          dedupeKey: `seed:${followed.id}:followed-update`,
          channels: ["IN_APP"],
        },
      });
      await writeAuditMany(tx, personaActor(complianceUser), ctx, [
        {
          action: "TICKET_FOLLOWED",
          entityType: "TICKET",
          entityId: followed.id,
          ticketId: followed.id,
          fieldChanged: "follower",
          oldValue: null,
          newValue: complianceUser.email,
          metadata: { followerId: follower.id, source: "MANUAL" },
        },
      ]);
    });
    written += 1;
  }

  // --- A FORWARDED hold, with the candidate the parser read out of the forwarded block.
  //
  //     Fix round 1. `releaseHeldIntake`'s `releaseAsCandidate` branch, `resolveForwardedRelease` and
  //     the `candidateRequesterEmail` column all shipped with no fixture that exercises them, so the
  //     forwarded-mail path could not be walked once on a freshly seeded database — and the release
  //     dialog's second attribution path had nothing to render against.
  //
  //     The shape is the one `resolveForwardedRelease` ALLOWS, deliberately: a staff member forwarded
  //     a client's mail on, the forward itself passed sender authentication, and the embedded sender
  //     is a distinct address. Anything less would seed a row whose only outcome is a refusal.
  //     `SuspendedIntake` is append-only, so this is created only when it is absent.
  const forwardMessageId = "<seed-forwarded-1@mail.example.com>";
  const existingForward = await refs.db.suspendedIntake.findFirst({
    where: { messageId: forwardMessageId },
    select: { id: true },
  });
  if (existingForward === null) {
    await inSeedTx(refs, async (tx) => {
      const row = await tx.suspendedIntake.create({
        data: {
          reason: "FORWARDED",
          status: "NEW",
          mailbox: "service@example.com",
          // The FORWARDER: active staff, which is one of the three things the release gate re-checks.
          fromAddress: csUser.email,
          subject: "Fwd: Wire instructions for the Tuesday transfer",
          messageId: forwardMessageId,
          snippet: sanitizePII(
            "---------- Forwarded message ----------\nFrom: Gwen Spencer <gwen.spencer@example.com>\n\n" +
              "Could you confirm the Tuesday transfer is still on? Thanks.",
          ).text,
          senderVerified: true,
          candidateRequesterEmail: "gwen.spencer@example.com",
        },
        select: { id: true },
      });
      await writeAuditMany(tx, personaActor(csUser), ctx, [
        {
          action: "INTAKE_SUSPENDED",
          entityType: "SUSPENDED_INTAKE",
          entityId: row.id,
          fieldChanged: "reason",
          oldValue: null,
          newValue: "FORWARDED",
          metadata: {
            source: "email",
            mailbox: "service@example.com",
            messageId: forwardMessageId,
            detail: null,
            // The keys `auditFactsFor` reads back. `senderVerified: true` is what makes the candidate
            // release reachable rather than refused as SENDER_NOT_AUTHENTICATED.
            senderVerified: true,
            candidateRequesterEmail: "gwen.spencer@example.com",
          },
        },
      ]);
    });
  }
  written += 1;

  // --- A pair of suppressions: one live, one already lifted.
  //
  //     Fix round 2. `RequesterSuppression` was in neither half of this step's coverage statement —
  //     not in the list of tables it seeds and not in the list it argues against seeding — so
  //     `/admin/suppression` rendered two empty lists on every freshly seeded database and the
  //     remove dialog had nothing to open on. The omission was silent, which is the one thing the
  //     "each for a reason" framing above exists to prevent.
  //
  //     TWO rows, because the page renders two states and one row can only be in one of them: live
  //     rows first (the decision that is in force, and the only shape the remove dialog can act on),
  //     removed rows after (the evidence that the desk stopped writing to somebody and then started
  //     again — `listSuppressions` lists them deliberately, and a seed with no lifted row would hide
  //     the half of the screen that explains that history).
  //
  //     The lifted row is written as the two decisions it actually was: an add and, later, a
  //     removal, each its own transaction ending in its own audit batch (§3 rule 2). Collapsing
  //     them into one row with `removedAt` already set and a single ledger entry would seed a
  //     suppression nobody is recorded as having lifted.
  //
  //     `RequesterSuppression` is soft-removed and never deleted (`requester_suppression_no_delete`),
  //     and `email` is unique — one live decision per address — so both rows are created only when
  //     the address is absent, exactly like the FORWARDED hold above.
  const suppressionSeeds = [
    {
      // LIVE. A hard bounce an administrator confirmed: the shape `confirmBounceSuppression` produces,
      // and the reason the candidates list exists. The dev seed writes no deliveries, so this
      // suppresses an address nothing is queued to — the row is the decision, not its effect.
      email: "reynold.hayes@example.com",
      reason: "HARD_BOUNCE" as const,
      note: "550 5.1.1 user unknown — mailbox closed at the client's employer; new address requested by phone.",
      lift: null,
    },
    {
      // LIFTED. Suppressed on the client's own request and released once they asked for mail again,
      // which is the sequence the removed half of the list is there to show.
      email: "norene.nitzsche@example.com",
      reason: "UNSUBSCRIBE_REQUEST" as const,
      note: "Client asked on the phone to stop receiving email updates while travelling.",
      lift: "Client called back and asked for email updates again; confirmed the address on the line.",
    },
  ];
  for (const s of suppressionSeeds) {
    const existing = await refs.db.requesterSuppression.findUnique({
      where: { email: s.email },
      select: { id: true },
    });
    if (existing === null) {
      const created = await inSeedTx(refs, async (tx) => {
        const row = await tx.requesterSuppression.create({
          data: {
            email: s.email,
            reason: s.reason,
            // I4: the note is free text an operator pasted, so it is sanitized before it is stored —
            // `addSuppression` KEEPS the redacted value rather than refusing it, and so does this.
            note: sanitizePII(s.note).text,
            createdById: opsUser.id,
          },
          select: { id: true },
        });
        await writeAuditMany(tx, personaActor(opsUser), ctx, [
          {
            action: "SUPPRESSION_ADDED",
            entityType: "SUPPRESSION",
            entityId: row.id,
            fieldChanged: "email",
            oldValue: null,
            newValue: s.email,
            // The keys `addSuppression` writes, including `resuppressed` — false here for both rows,
            // because neither address had been suppressed before.
            metadata: { reason: s.reason, note: sanitizePII(s.note).text, resuppressed: false },
          },
        ]);
        return row.id;
      });

      if (s.lift !== null) {
        await inSeedTx(refs, async (tx) => {
          // Pinned to "still live" exactly as `removeSuppression` pins it.
          const lifted = await tx.requesterSuppression.updateMany({
            where: { id: created, removedAt: null },
            data: { removedAt: new Date(), removedById: opsUser.id },
          });
          assert(lifted.count === 1, `suppression ${s.email}: expected to lift 1 row, lifted ${lifted.count}`);
          await writeAuditMany(tx, personaActor(opsUser), ctx, [
            {
              action: "SUPPRESSION_REMOVED",
              entityType: "SUPPRESSION",
              entityId: created,
              fieldChanged: "email",
              oldValue: s.email,
              newValue: null,
              metadata: { reason: sanitizePII(s.lift).text, priorReason: s.reason },
            },
          ]);
        });
      }
    }
  }
  written += 1;

  return written;
}

// ---------------------------------------------------------------------------
// Step 8 (persona reads) and step 9 (chain verification)
// ---------------------------------------------------------------------------

function personaActor(u: UserRow): AuditActor {
  return { id: u.id, email: u.email, groups: [...u.groups] };
}

/**
 * The rows `recordView` and `recordDenied` write, written through the seed's transaction. Those helpers
 * use the global client, whose separate connection would wait on the ledger's chain lock that this
 * transaction already holds.
 */
async function seedPersonaReads(refs: SeedRefs, seeded: Map<string, SeededTicket>): Promise<{ views: number; denied: number }> {
  const ctx = systemRequestContext("seed");
  let views = 0;
  for (const v of VIEW_FIXTURES) {
    const persona = requireUser(refs, v.persona);
    const ticket = seeded.get(v.ticketRef);
    assert(ticket, `view fixture: ticket ${v.ticketRef} was not seeded`);
    await writeAudit(refs.db, personaActor(persona), ctx, {
      action: v.mode === "DETAIL" ? "TICKET_VIEWED" : "TICKET_PREVIEWED",
      entityType: "TICKET",
      entityId: ticket.id,
      ticketId: ticket.id,
      newValue: v.mode === "PREVIEW" ? "slide-over" : undefined,
    });
    views++;
  }
  const denied = requireUser(refs, DENIED_FIXTURE.persona);
  const target = seeded.get(DENIED_FIXTURE.ticketRef);
  assert(target, `denied fixture: ticket ${DENIED_FIXTURE.ticketRef} was not seeded`);
  await writeAudit(refs.db, personaActor(denied), ctx, {
    action: "AUTHZ_DENIED",
    entityType: deniedEntityType(DENIED_FIXTURE.what, target.id),
    entityId: target.id,
    ticketId: target.id,
    fieldChanged: "capability",
    newValue: DENIED_FIXTURE.what,
  });
  return { views, denied: 1 };
}

/** I4 end-to-end: none of the raw fixture values may exist anywhere in the database. */
async function assertNoRawPiiPersisted(db: DbTx): Promise<void> {
  const contains = (field: string) => RAW_PII_PROBES.map((probe) => ({ [field]: { contains: probe } }));
  const ticketHits = await db.ticket.count({
    where: { OR: [...contains("subject"), ...contains("description"), ...contains("clientReference"), ...contains("requesterName")] },
  });
  const commentHits = await db.comment.count({ where: { OR: contains("body") } });
  const auditHits = await db.auditLog.count({
    where: { OR: [...contains("oldValue"), ...contains("newValue"), ...contains("userAgent")] },
  });
  assert(ticketHits === 0, `${ticketHits} ticket row(s) contain a raw PII fixture value`);
  assert(commentHits === 0, `${commentHits} comment row(s) contain a raw PII fixture value`);
  assert(auditHits === 0, `${auditHits} audit row(s) contain a raw PII fixture value`);
}

/**
 * The other half of I4 since Decision #116: the routing number in the OPS-01 wire fixture must SURVIVE
 * the write, on the same row whose account number did not.
 *
 * A negative assertion cannot catch a rule that quietly comes back, or a neighbouring rule that
 * inherits what rule 3 used to consume — `assertNoRawPiiPersisted` would go green if `021000021` were
 * redacted again. This one fails instead, against the seeded database rather than a string in a test.
 */
async function assertRoutingNumberPersisted(db: DbTx): Promise<void> {
  const kept = await db.ticket.count({
    where: {
      description: { contains: PASS_THROUGH_ROUTING_PROBE },
      AND: [{ description: { contains: "[REDACTED:ACCOUNT" } }],
    },
  });
  assert(
    kept >= 1,
    `expected at least one seeded ticket whose description keeps the routing number ${PASS_THROUGH_ROUTING_PROBE} ` +
      "beside a redacted account number (Decision #116); found none",
  );
}

const CHAIN_SELECT = {
  seq: true,
  occurredAt: true,
  actorId: true,
  actorEmail: true,
  actorGroups: true,
  action: true,
  entityType: true,
  entityId: true,
  ticketId: true,
  fieldChanged: true,
  oldValue: true,
  newValue: true,
  ipAddress: true,
  userAgent: true,
  requestId: true,
  prevHash: true,
  hash: true,
} satisfies Prisma.AuditLogSelect;

export async function verifyWholeChain(db: DbTx): Promise<{ ok: boolean; checked: number; firstBadSeq: string | null; reason: string }> {
  const PAGE = 1000;
  let previousHash: string | null = null;
  let afterSeq: bigint | null = null;
  let checked = 0;
  let reason = "EMPTY";
  for (;;) {
    const rows: AuditChainRow[] = await db.auditLog.findMany({
      where: afterSeq === null ? undefined : { seq: { gt: afterSeq } },
      orderBy: { seq: "asc" },
      take: PAGE,
      select: CHAIN_SELECT,
    });
    if (rows.length === 0) break;
    const result = verifyChainRows(rows, previousHash);
    checked += result.checked;
    if (!result.ok) {
      return { ok: false, checked, firstBadSeq: result.firstBadSeq === null ? null : result.firstBadSeq.toString(), reason: result.reason };
    }
    reason = result.reason;
    const last = rows[rows.length - 1];
    previousHash = last.hash;
    afterSeq = last.seq;
    if (rows.length < PAGE) break;
  }
  return { ok: true, checked, firstBadSeq: null, reason: checked === 0 ? "EMPTY" : reason };
}

/**
 * HD numbers in creation order, oldest first, from `HISTORY_FIRST_NUMBER`, stepping around the numbers the
 * universe's stories already hold — so the board reads like a desk that has been running for months.
 */
function assignNumbers(fixtures: readonly TicketFixture[]): Map<string, number> {
  const reserved = new Set(fixtures.flatMap((f) => (f.number === undefined ? [] : [f.number])));
  const numbers = new Map<string, number>();
  for (const f of fixtures) if (f.number !== undefined) numbers.set(f.ref, f.number);
  let next = HISTORY_FIRST_NUMBER;
  for (const f of [...fixtures].filter((x) => x.number === undefined).sort((a, b) => b.createdMinAgo - a.createdMinAgo)) {
    while (reserved.has(next)) next++;
    numbers.set(f.ref, next++);
  }
  return numbers;
}

/** The SLA states the dashboard can show, each of which must be on the board at the first viewing hour. */
const SLA_STATES_ON_THE_BOARD: ReadonlyArray<readonly [SlaPhase, SlaStatus]> = [
  ["FIRST_RESPONSE", "BREACHED"],
  ["RESOLUTION", "ON_TRACK"],
  ["RESOLUTION", "WARNING"],
  ["RESOLUTION", "BREACHED"],
  ["COMPLETE", "MET"],
  ["COMPLETE", "BREACHED"],
];

export type SeedSummary = {
  users: number;
  tickets: number;
  comments: number;
  attachments: number;
  auditRows: number;
  numbers: { first: number; last: number };
  slaAtView: Record<string, number>;
  viewStart: string;
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Writes the whole demo desk into an EMPTY database through `db`, the caller's transaction, then verifies
 * the ledger's hash chain. The reference rows (machine users, queues, SLA policies, macros) must already
 * be there. Any failed assertion throws, which rolls the caller's transaction back.
 */
export async function seedFromUniverse(db: DbTx, opts: { universe: Universe; now?: Date }): Promise<SeedSummary> {
  // Second guard (seed.ts and the reset refuse first): the demo data never reaches a production database.
  // Keyed on APP_ENV, the deployment label, not NODE_ENV.
  if (process.env.APP_ENV === "production") {
    throw new Error("seedFromUniverse refused: APP_ENV=production");
  }
  const { universe } = opts;
  const now = opts.now ?? new Date();
  const existingTickets = await db.ticket.count();
  assert(existingTickets === 0, `the demo seed writes into an empty desk; found ${existingTickets} ticket(s)`);

  // Step 3 — users.
  const users = await seedUsers(db, universe, now);

  // Reference rows the fixtures depend on (written by the reference seed).
  const queues = await db.queue.findMany({ select: { id: true, key: true } });
  const queueIds = {} as Record<QueueKey, string>;
  for (const q of queues) queueIds[q.key] = q.id;
  for (const key of ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"] as const) {
    assert(queueIds[key], `queue ${key} missing — run the reference seed first`);
  }
  const macroRows = await db.macro.findMany({
    select: { id: true, key: true, queueId: true, body: true, channel: true, disclaimerKey: true, isActive: true },
  });
  const macros = new Map<string, MacroRow>(macroRows.map((m) => [m.key, m]));
  const slaRows = await db.sLA.findMany({ select: { priority: true, firstResponseMinutes: true, resolutionMinutes: true } });
  const policies = new Map<TicketPriority, SlaPolicyInput>(
    TICKET_PRIORITIES.map((p) => [p, slaPolicyFor(p, slaRows.find((r) => r.priority === p))]),
  );
  const viewStart = viewingStart(now);
  const close = lastDeskClose(now);

  // Steps 5–7 — every ticket: the hand-written set and the stories (open ones re-timed for the viewing
  // day), then the history. Written oldest first, so the ledger reads in the order things happened.
  const fixtures = [
    ...placeForViewing([...TICKET_FIXTURES, ...storyFixtures(universe, now)], { now, close, viewStart, policies }),
    ...historyFixtures(universe, now, policies),
  ];
  const refs: SeedRefs = {
    db,
    now,
    close,
    viewStart,
    users,
    queueIds,
    macros,
    policies,
    attachments: new Map(buildDemoAttachments(universe).map((a) => [a.id, a])),
    numbers: assignNumbers(fixtures),
  };
  validateFixtures(refs, fixtures);
  const seeded = new Map<string, SeededTicket>();
  for (const f of [...fixtures].sort((a, b) => b.createdMinAgo - a.createdMinAgo)) {
    seeded.set(f.ref, await seedTicket(f, refs));
  }
  const waveB = await seedWaveBFixtures(refs, seeded);
  const reads = await seedPersonaReads(refs, seeded);
  await assertNoRawPiiPersisted(db);
  await assertRoutingNumberPersisted(db);

  // Coverage, asserted rather than hoped for: a Wave B table with no row is a panel nobody has ever
  // seen rendered. The groups are the link, the retraction, the review stamp, the follower, the
  // forwarded hold and the suppressions.
  assert(waveB === 6, `expected 6 Wave B fixture groups, wrote ${waveB}`);
  const [links, retractions, stamps, followers, notifications, forwardedHolds, liveSuppressions, liftedSuppressions] =
    await Promise.all([
      db.ticketLink.count(),
      db.commentRetraction.count(),
      db.reviewStamp.count(),
      db.ticketFollower.count(),
      db.notification.count(),
      db.suspendedIntake.count({ where: { reason: "FORWARDED" } }),
      db.requesterSuppression.count({ where: { removedAt: null } }),
      db.requesterSuppression.count({ where: { removedAt: { not: null } } }),
    ]);
  for (const [label, n] of [
    ["TicketLink", links],
    ["CommentRetraction", retractions],
    ["ReviewStamp", stamps],
    ["TicketFollower", followers],
    ["Notification", notifications],
    // Fix round 1: without one of these the forwarded-mail release path cannot be walked at all.
    ["SuspendedIntake(FORWARDED)", forwardedHolds],
    // Fix round 2: /admin/suppression renders live rows and removed rows as two different things,
    // so both states are counted — one row could only ever have proved one of them.
    ["RequesterSuppression(live)", liveSuppressions],
    ["RequesterSuppression(lifted)", liftedSuppressions],
  ] as const) {
    assert(n > 0, `${label} has no fixture row — the surface that renders it would be permanently empty`);
  }

  // The board a visitor sees at the first viewing hour has every SLA state on it.
  const slaAtView: Record<string, number> = {};
  for (const t of seeded.values()) {
    const key = `${t.slaAtView.phase}/${t.slaAtView.status}`;
    slaAtView[key] = (slaAtView[key] ?? 0) + 1;
  }
  for (const [phase, status] of SLA_STATES_ON_THE_BOARD) {
    assert((slaAtView[`${phase}/${status}`] ?? 0) > 0, `no ticket reads ${phase}/${status} at the first viewing hour`);
  }

  // Tickets created in the app continue after the seeded numbers. ALTER SEQUENCE, not setval: setval is
  // not undone by a rollback, and a failed reset must leave yesterday's numbering as it was.
  await db.$executeRawUnsafe(
    `DO $$ BEGIN EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', pg_get_serial_sequence('"Ticket"', 'number'), ` +
      `(SELECT max("number") + 1 FROM "Ticket")); END $$`,
  );

  // Step 9 — chain verification over the whole ledger.
  const chain = await verifyWholeChain(db);
  if (!chain.ok) {
    throw new Error(`audit chain verification FAILED at seq ${chain.firstBadSeq ?? "?"} (${chain.reason})`);
  }
  const [ticketCount, commentCount, userCount, attachmentCount] = await Promise.all([
    db.ticket.count(),
    db.comment.count(),
    db.user.count(),
    db.attachment.count(),
  ]);
  const numbers = [...seeded.values()].map((t) => t.number);
  console.log(
    `demo seed: ${seeded.size} tickets (HD-${Math.min(...numbers)}…HD-${Math.max(...numbers)}), ` +
      `Wave B ${links}/${retractions}/${stamps}/${followers}/${notifications}/${forwardedHolds}/${liveSuppressions}+${liftedSuppressions}, ` +
      `persona reads ${reads.views}+${reads.denied}, audit chain verified over ${chain.checked} rows`,
  );
  return {
    users: userCount,
    tickets: ticketCount,
    comments: commentCount,
    attachments: attachmentCount,
    auditRows: chain.checked,
    numbers: { first: Math.min(...numbers), last: Math.max(...numbers) },
    slaAtView,
    viewStart: viewStart.toISOString(),
  };
}
