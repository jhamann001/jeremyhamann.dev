// The firm's funding work, planned once for the deals and transfers parts: every movement of money or securities
// into Cedar Ridge with the deal it came from, and the deals that never became a movement. Built from the universe
// and from the Transfer Tracker's own plan (tracker-plan.ts, the tracker demo's planDemoTransfers), so an ACAT in
// AoA's workspace is the same transfer the ACAT book holds: same household, account, firm, value, days and control
// number. Pure: no database. Every day is a business day relative to the seed's `today`.
//
// Ids have production's shapes: a transfer id is cuid-shaped (app.transfer's own default) and a deal carries a CRM
// opportunity id (006…). The app treats ids starting DEMO- as its old development seed and leaves them out of
// reporting, so none are used here. The stories' ids come from universe.ts (storyTransferId, storyDealId); the rest:
//   the tracker's open inbound ACATs   deals 006… 2001+ for tr-o01 …
//   its recently finished ones          deals 006… 3000+ for tr-hxxx (Funded)
//   cash and preparation work           deals 006… 4001+, no tracker record
//   pipeline-only deals                 006… 5001+ (Potential) and 6001+ (Lost)

import type { DealStage } from "@/lib/data/deal-types";
import type { FundingType, TransferOwner, TransferStage } from "@/lib/data/transfer-types";
import { addBusinessDays, addCalendarDays, businessDaysBetween } from "./calendar";
import type { SeedContext } from "./context";
import { accountOwners } from "./people";
import { planDemoTransfers, type PlannedTransfer } from "./tracker-plan";
import {
  crmId, demoCuid, householdOf, seeded, seededInt, staffEmail, staffOf, storyDealId, storyTrackerId, storyTransferId,
  type Universe, type UniverseAccount, type UniverseHousehold, type UniversePerson,
} from "./universe";

export type Actor = { email: string | null; role: string; name: string };

/** A cuid-shaped id, the same for the same key (universe.ts). */
export const cuidFor = demoCuid;

/** A deal's CRM opportunity id. */
export const dealCrmId = (n: number): string => crmId("006", n);

/** The CRM feed: deals arrive and close through it (POST /api/ingest/deals); it has no acting user. */
export const CRM_FEED: Actor = { email: null, role: "INGEST", name: "crm-deals" };

export type MailingPlan = {
  day: string;
  reason: string;
  items: string[];
  note?: string;
  journey: string;
  postage?: number;
  /** One per journey leg, in order. */
  legs: Array<{ carrier?: string; tracking?: string; mailed?: string; received?: string }>;
};

export type ExtraTask = {
  title: string;
  team: "Client Service" | "Operations" | "Operations / Client Service";
  status: "Ready" | "Waiting";
  day: string;
  assignedTo?: string;
  followUpOn?: string;
  doneDay?: string;
};

export type PlannedDecision = {
  symbol: string;
  description: string;
  value: number;
  basis: number | null;
  decision: "BRING_IN" | "LEAVE_GIFT" | "UNDECIDED";
  liquidate?: boolean;
};

export interface Movement {
  key: string;
  transferId: string;
  dealSfId: string;
  storyId?: string;
  trackerId: string | null;
  acatTransferId: string | null;
  trackerStatus: string | null;
  household: UniverseHousehold;
  owners: UniversePerson[];
  /** The receiving account at Apex (a universe account), or a new one to open. */
  account: UniverseAccount;
  newReceiving?: { type: string; open: string | null };
  firm: string;
  firmAvgDays: number;
  sourceType: string;
  sourceLast4: string | null;
  fundingType: FundingType;
  stage: TransferStage;
  value: number;
  owner: { kind: TransferOwner; name: string | null };
  nextStep: string | null;
  nextStepOwner: string | null;
  // what happened, by day
  created: string;
  createdBy: Actor;
  clientRequest?: { day: string; source: "Client app" | "Client Service" | "Signed paperwork" };
  statement?: { day: string; accepted: boolean };
  match?: string;
  receivingOpen: string | null;
  plan?: { day: string; by: Actor; decisions?: PlannedDecision[] };
  formReview?: string;
  sentPacket?: string;
  returnedSignature?: string;
  appAuthorization?: string;
  mailedPaperwork?: string;
  drsServiceRequest?: string;
  mailing?: MailingPlan;
  submission?: { day: string; control: string };
  inTransfer?: { day: string; by: Actor };
  accepted?: string;
  tracking: Array<{ day: string; stage: string; expected?: string | null }>;
  rejection?: { day: string; reason: string; code: string; owner: string; response?: { day: string; text: string } };
  checkTicket?: { day: string; mailerSent: boolean; checkMailed: boolean };
  achInitiation?: { day: string; clientDay: string };
  cashInFlight?: string;
  receipt?: { day: string; partial?: { nextAction: string; owner: string; nextCheck: string }; lines: number; mismatch?: string };
  funded?: { day: string; by: Actor };
  /** Closeout checklist items ticked so far (of seven). */
  closeoutDone: number;
  /** FUNDED checklist items done (of four), in order. */
  fundedTasksDone: number;
  feeReimbursement?: string;
  residual?: { day: string; trackerStage: string };
  outcome?: { day: string; outcome: "Deferred" | "Client declined"; reason: string; followUpOn?: string };
  archived?: { day: string; reason: "deal_lost" };
  syncFlag?: "uncommitted_review";
  /** DECISION statuses that keep the synced checklist titles in step with the deal. */
  partialTasksDone?: number;
  drsTasksDone?: number;
  /** A partial ACAT's decision worksheet, sent but not yet decided (no plan yet). */
  worksheet?: PlannedDecision[];
  extraTasks: ExtraTask[];
  deal: DealPlan;
}

export interface DealPlan {
  sfDealId: string;
  household: UniverseHousehold;
  client: UniversePerson;
  account: UniverseAccount | null;
  firm: string;
  accountType: string;
  last4: string | null;
  amount: number;
  stage: DealStage;
  history: Array<{ stage: DealStage; from: DealStage | null; day: string; by: Actor }>;
  closeDay: string | null;
  lastActivity: string;
  statements: boolean;
  assetMapped: boolean;
  employer?: string | null;
  rollingInto?: string | null;
  lostFrom?: DealStage;
}

export interface FundingWork {
  movements: Movement[];
  /** Deals with no movement: Potential, or Lost before one was opened. */
  pipelineDeals: DealPlan[];
}

// --- vocabularies (the app's own, see the comments where each is used) ---

/** The deal's funding type (lib/data/deal-types.ts FUNDING_TYPES) for a universe account type. */
const DEAL_ACCOUNT_TYPE: Record<string, string> = {
  "joint-taxable": "JT WROS",
  individual: "Individual Brokerage",
  trust: "Trust",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Traditional IRA",
  "sep-ira": "SEP IRA",
  "roth-ira": "Roth IRA",
};

/** The source account's type at intake (lib/transfers/new-transfer-intake.ts INTAKE_ACCOUNT_TYPES). */
const INTAKE_TYPE: Record<string, string> = {
  "joint-taxable": "Joint",
  individual: "Individual",
  trust: "Trust",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Traditional IRA",
  "sep-ira": "Traditional IRA",
  "roth-ira": "Roth IRA",
};

/** The registration both sides of the account-type match name (lib/transfers/transfer-registration.ts). */
export const REGISTRATION: Record<string, string> = {
  "joint-taxable": "Joint tenants with rights of survivorship",
  individual: "Individual",
  trust: "Trust",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Traditional IRA",
  "sep-ira": "SEP IRA",
  "roth-ira": "Roth IRA",
};

/** The tracker's working statuses as a tracking stage on the workspace (free text, at most 80 characters). */
const TRACKING_STAGE: Record<string, string> = {
  WaitingForApex: "Waiting for Apex to send the request",
  Submitted: "Submitted to Apex",
  PendingReview: "Pending review at the delivering firm",
  PendingContraResponse: "Waiting on the delivering firm's response",
  Accepted: "Accepted by the delivering firm",
  PendingSettlement: "Accepted; positions settling",
  PendingBookkeeping: "Settled; Apex bookkeeping in progress",
  Completed: "Completed",
};

const ACCEPTED = new Set(["Accepted", "PendingSettlement", "PendingBookkeeping", "Completed"]);

export type DealOpts = {
  stage: DealStage; potentialDays?: number; employer?: string | null; rollingInto?: string | null; statements?: boolean;
  assetMapped?: boolean; accountType?: string; lostFrom?: DealStage;
};

// --- helpers ---

function actorFor(universe: Universe, staffId: string): Actor {
  const s = staffOf(universe, staffId);
  const role = s.role === "advisor" ? "ADVISOR" : s.role === "client-service" ? "CLIENT_SERVICE" : s.role === "compliance" ? "ADMIN" : "OPERATIONS";
  return { email: staffEmail(s), role, name: s.name };
}

const last4Of = (number: string | null | undefined): string | null => {
  const compact = (number ?? "").replace(/[^A-Za-z0-9]/g, "");
  return compact ? compact.slice(-4) : null;
};

/** The later of two days. */
const later = (a: string, b: string) => (a > b ? a : b);

function firstAccount(universe: Universe, householdId: string): UniverseAccount {
  const account = universe.accounts.find((a) => a.household === householdId);
  if (!account) throw new Error(`universe household ${householdId} has no account`);
  return account;
}

function accountById(universe: Universe, id: string): UniverseAccount {
  const account = universe.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`universe account ${id} not found`);
  return account;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- the plan ---

const cache = new WeakMap<SeedContext, FundingWork>();

/** The firm's funding work for this seed (computed once per seed run). */
export function planFundingWork(ctx: SeedContext): FundingWork {
  const cached = cache.get(ctx);
  if (cached) return cached;
  const work = buildFundingWork(ctx.universe, ctx.now, ctx.today);
  cache.set(ctx, work);
  return work;
}

export function buildFundingWork(universe: Universe, now: Date, today: string): FundingWork {
  const tracker = planDemoTransfers(universe, now);
  if (tracker.today !== today) throw new Error(`tracker plan day ${tracker.today} differs from the seed's ${today}`);
  const staff = {
    helen: actorFor(universe, "helen-carver"),
    jordan: actorFor(universe, "jordan-reyes"),
    marco: actorFor(universe, "marco-ferreira"),
  };
  const advisorOf = (h: UniverseHousehold) => actorFor(universe, h.advisor);
  const ago = (n: number) => addBusinessDays(today, -n);
  const ahead = (n: number) => addBusinessDays(today, n);

  const movements: Movement[] = [];

  /** The common deal for a movement: Potential from the CRM, committed by the advisor, then on through the stages. */
  function dealFor(m: Omit<Movement, "deal">, opts: DealOpts): DealPlan {
    const advisor = advisorOf(m.household);
    const committed = addBusinessDays(m.created, -1);
    const potential = addBusinessDays(committed, -(opts.potentialDays ?? seededInt(`${m.key}:potential`, 6, 22)));
    const history: DealPlan["history"] = [{ stage: "POTENTIAL", from: null, day: potential, by: CRM_FEED }];
    // A transfer exists only once the deal was committed; a deal back at Potential was moved back by its advisor.
    history.push({ stage: "COMMITTED", from: "POTENTIAL", day: committed, by: advisor });
    if (opts.stage === "POTENTIAL") {
      history.push({ stage: "POTENTIAL", from: "COMMITTED", day: addBusinessDays(m.plan?.day ?? m.created, 2), by: advisor });
    }
    if (opts.stage === "FUNDING" || opts.stage === "WON") {
      history.push({ stage: "FUNDING", from: "COMMITTED", day: m.inTransfer?.day ?? m.created, by: m.inTransfer?.by ?? staff.jordan });
    }
    if (opts.stage === "WON") history.push({ stage: "WON", from: "FUNDING", day: m.funded!.day, by: CRM_FEED });
    if (opts.stage === "LOST") {
      history.push({ stage: "LOST", from: opts.lostFrom ?? "COMMITTED", day: m.archived?.day ?? m.created, by: advisor });
    }
    const lastDay = history[history.length - 1].day;
    return {
      sfDealId: m.dealSfId,
      household: m.household,
      client: m.owners[0],
      account: m.account,
      firm: m.firm,
      accountType: opts.accountType ?? DEAL_ACCOUNT_TYPE[m.account.type] ?? "Other",
      last4: m.sourceLast4,
      amount: m.value,
      stage: opts.stage,
      history,
      closeDay: opts.stage === "WON" ? m.funded!.day : opts.stage === "LOST" ? lastDay : addCalendarDays(m.created, 21 + seededInt(`${m.key}:close`, 0, 20)),
      lastActivity: later(lastDay, m.tracking.at(-1)?.day ?? lastDay),
      statements: opts.statements ?? (m.statement?.accepted ?? false),
      assetMapped: opts.assetMapped ?? (m.plan != null && (m.fundingType === "ACAT_FULL" || m.fundingType === "ACAT_PARTIAL")),
      employer: opts.employer,
      rollingInto: opts.rollingInto,
      lostFrom: opts.lostFrom,
    };
  }

  /** Fills the ACAT path from intake to submission for a tracker transfer. */
  function acatMovement(t: PlannedTransfer, key: string, transferId: string, dealSfId: string): Omit<Movement, "deal"> {
    const household = householdOf(universe, t.household);
    const owners = accountOwners(universe, t.account);
    const partial = t.type === "Partial";
    const manual = t.workflow === "MANUAL";
    const drs = t.workflow === "DRS";
    const fundingType: FundingType = drs ? "DRS" : manual ? "MANUAL" : partial ? "ACAT_PARTIAL" : "ACAT_FULL";
    const appAuth = t.method === "API" && !manual && !drs && !partial && seeded(`${key}:app`) < 0.5;
    // Preparation: intake the business day before the client's request is logged, the plan the day after.
    const created = addBusinessDays(t.requestDay, -1);
    const planDay = later(t.requestDay, created);
    const signed = t.submissionDay ? addBusinessDays(t.submissionDay, -1) : null;
    const submitted = t.submissionDay;
    const accepted = submitted && ACCEPTED.has(t.status) ? addBusinessDays(submitted, Math.min(2, businessDaysBetween(submitted, t.lastDay))) : undefined;
    const tracking: Movement["tracking"] = [];
    if (submitted && fundingType !== "MANUAL" && fundingType !== "DRS" && t.controlNumber && t.controlNumber !== "To Come") {
      const expected = addBusinessDays(submitted, t.firm.avgDays);
      tracking.push({ day: submitted, stage: TRACKING_STAGE.Submitted, expected });
      if (t.status !== "Submitted" && t.status !== "Rejected" && TRACKING_STAGE[t.status] && t.status !== "Completed") {
        tracking.push({ day: t.lastDay, stage: TRACKING_STAGE[t.status], expected });
      }
      if (accepted && t.status !== "Accepted") tracking.splice(1, 0, { day: accepted, stage: TRACKING_STAGE.Accepted, expected });
      if (t.status === "Completed") tracking.push({ day: t.completionDay!, stage: TRACKING_STAGE.Completed, expected: null });
    }
    const sourceLast4 = last4Of(t.statementAccountNumber);
    return {
      key,
      transferId,
      dealSfId,
      storyId: t.storyId,
      trackerId: t.id,
      acatTransferId: t.storyId ?? t.acatTransferId ?? null,
      trackerStatus: t.status,
      household,
      owners,
      account: t.account,
      firm: t.firm.name,
      firmAvgDays: t.firm.avgDays,
      sourceType: INTAKE_TYPE[t.account.type] ?? "Individual",
      sourceLast4,
      fundingType,
      stage: submitted ? (t.status === "Completed" ? "FUNDED" : "IN_TRANSFER") : "DECISION",
      value: t.value,
      owner: submitted ? { kind: "OPERATIONS", name: staff.jordan.name } : { kind: "CLIENT_SERVICE", name: staff.helen.name },
      nextStep: null,
      nextStepOwner: null,
      created,
      createdBy: staff.helen,
      clientRequest: { day: t.requestDay, source: appAuth ? "Client app" : partial || manual ? "Signed paperwork" : "Client Service" },
      statement: t.status === "WaitingForStatement" ? undefined : { day: planDay, accepted: true },
      match: t.status === "WaitingForStatement" ? undefined : planDay,
      receivingOpen: t.status === "PendingAccountOpening" ? null : created,
      plan: t.status === "WaitingForStatement" ? undefined : { day: planDay, by: staff.jordan },
      formReview: submitted && !manual && !drs ? planDay : undefined,
      sentPacket: submitted && !appAuth && !manual && !drs ? planDay : undefined,
      returnedSignature: signed && !appAuth && !drs ? signed : undefined,
      appAuthorization: appAuth ? planDay : undefined,
      mailedPaperwork: manual && signed ? signed : undefined,
      drsServiceRequest: drs && signed ? signed : undefined,
      submission: submitted && !manual && !drs && t.controlNumber && t.controlNumber !== "To Come" ? { day: submitted, control: t.controlNumber } : undefined,
      inTransfer: submitted ? { day: submitted, by: staff.jordan } : undefined,
      accepted,
      tracking,
      closeoutDone: 0,
      fundedTasksDone: 0,
      extraTasks: [],
    };
  }

  // --- the nine stories ---

  const storyPlans = new Map(tracker.transfers.filter((t) => t.storyId).map((t) => [t.storyId!, t]));
  for (const story of universe.stories.transfers) {
    const t = storyPlans.get(story.id);
    if (!t) throw new Error(`tracker plan has no ${story.id}`);
    const key = `story:${story.id}`;
    const base = acatMovement(t, key, storyTransferId(story.id), storyDealId(story.id));
    if (t.id !== storyTrackerId(story.id)) throw new Error(`tracker id ${t.id} for ${story.id}`);
    const m: Omit<Movement, "deal"> = { ...base };
    const client = m.owners[0];
    switch (story.id) {
      case "T-311": // paperwork out by DocuSign; the second signature is missing
        m.formReview = ago(2);
        m.sentPacket = ago(2);
        m.nextStep = "Chase the missing joint owner signature on the DocuSign packet.";
        m.nextStepOwner = "Client Service";
        m.extraTasks.push({
          title: "Joint owner signature missing on the transfer paperwork", team: "Client Service", status: "Waiting",
          day: ago(1), assignedTo: staff.helen.name, followUpOn: ahead(1),
        });
        break;
      case "T-312": // a non-ACAT transfer from BNY: the form needs a medallion signature guarantee
        m.mailing = {
          day: m.plan!.day, reason: "Wet Signature", items: ["Manual Transfer Paperwork", "Return shipping label"],
          note: "Medallion signature guarantee required", journey: "Cedar Ridge to the client to Cedar Ridge to the final destination",
          legs: [{ carrier: "FedEx", tracking: `7735 ${seededInt(`${key}:fx`, 1000, 9999)} ${seededInt(`${key}:fx2`, 1000, 9999)}`, mailed: m.plan!.day }, {}, {}],
          postage: 18.4,
        };
        m.nextStep = "Client takes the BNY form to the bank for a medallion signature guarantee.";
        m.nextStepOwner = "Client Service";
        m.extraTasks.push({
          title: "Medallion signature guarantee needed on the BNY transfer form", team: "Client Service", status: "Waiting",
          day: m.plan!.day, assignedTo: staff.helen.name, followUpOn: ahead(3),
        });
        break;
      case "T-305":
      case "T-304":
        m.nextStep = "Watch for the delivering firm to accept the request.";
        m.nextStepOwner = "Operations";
        break;
      case "T-298": { // partial: Edward Jones sells BBGLX first and sends the proceeds as cash
        const statement = universe.stories.statements.find((s) => s.id === story.statement)!;
        const positions = statement.accounts![0].positions;
        m.plan = {
          ...m.plan!,
          decisions: positions.map((p) => {
            const security = universe.securities.find((s) => s.symbol === p.symbol);
            const cash = p.symbol === "CASH";
            const liquidate = p.symbol === "BBGLX";
            return {
              symbol: p.symbol,
              description: cash ? "Cash and money market" : security?.name ?? p.description ?? p.symbol,
              value: p.value,
              basis: cash ? p.value : round2(p.value * (0.45 + 0.4 * seeded(`${key}:${p.symbol}:basis`))),
              decision: liquidate ? "LEAVE_GIFT" : "BRING_IN",
              liquidate,
            } satisfies PlannedDecision;
          }),
        };
        m.mailing = {
          day: m.plan.day, reason: "Wet Signature", items: ["Signed transfer paperwork", "Return shipping label"],
          journey: "Cedar Ridge to the client to Cedar Ridge to the final destination",
          legs: [
            { carrier: "FedEx", tracking: `7735 ${seededInt(`${key}:fx`, 1000, 9999)} ${seededInt(`${key}:fx2`, 1000, 9999)}`, mailed: m.plan.day, received: addBusinessDays(m.plan.day, 1) },
            { carrier: "FedEx", tracking: `7735 ${seededInt(`${key}:fx3`, 1000, 9999)} ${seededInt(`${key}:fx4`, 1000, 9999)}`, mailed: addBusinessDays(m.plan.day, 1), received: m.returnedSignature },
            {},
          ],
          postage: 24.1,
        };
        m.partialTasksDone = 2;
        m.tracking.push({ day: ago(1), stage: "BBGLX sale settling at Edward Jones; proceeds follow as cash", expected: ahead(2) });
        m.nextStep = "Watch for the BBGLX sale proceeds, then confirm the arrival.";
        m.nextStepOwner = "Operations";
        break;
      }
      case "T-301":
        m.nextStep = "Confirm the arrival once the positions settle.";
        m.nextStepOwner = "Operations";
        break;
      case "T-287":
      case "T-280": {
        m.receipt = {
          day: t.completionDay!, lines: Math.max(1, t.assets.length),
          ...(story.id === "T-280" ? { mismatch: "Fractional share paid as cash in lieu; one share short against the statement." } : {}),
        };
        m.funded = { day: t.completionDay!, by: staff.jordan };
        m.closeoutDone = story.id === "T-287" ? 7 : 4;
        m.fundedTasksDone = story.id === "T-287" ? 4 : 1;
        m.feeReimbursement = t.fee?.feeRequestSubmitted ?? undefined;
        if (story.id === "T-287") m.residual = { day: addBusinessDays(t.completionDay!, 1), trackerStage: "Monitoring for residual credits" };
        if (story.id === "T-280") {
          m.nextStep = "Verify cost basis for the remaining lots.";
          m.nextStepOwner = "Operations";
        }
        break;
      }
      case "T-299": { // rejected for a Jr. suffix; Client Service has answered and Operations reviews
        const rejected = t.lastDay;
        m.rejection = {
          day: rejected, reason: t.rejectionReason ?? "Name mismatch: the delivering account is titled with a Jr. suffix.",
          code: "Account title mismatch", owner: "Client Service",
          response: { day: ago(1), text: `${client.first} ${client.last} signed new paperwork with the Jr. suffix as the delivering firm has the account titled.` },
        };
        m.accepted = undefined;
        m.tracking = m.tracking.filter((u) => u.stage === TRACKING_STAGE.Submitted);
        m.tracking.push({ day: rejected, stage: "ACAT rejected", expected: null });
        m.nextStep = "Review the corrected paperwork, then resubmit the ACAT.";
        m.nextStepOwner = "Operations";
        break;
      }
    }
    const stage: DealStage = story.stage === "paperwork" ? "COMMITTED" : story.stage === "completed" ? "WON" : "FUNDING";
    movements.push({ ...m, deal: dealFor(m, { stage, statements: true }) });
  }

  // --- the tracker's open inbound ACATs (one per working status, on quiet households) ---

  const open = tracker.transfers.filter((t) => /^tr-o\d+$/.test(t.id) && t.direction === "In");
  open.forEach((t) => {
    const n = Number(t.id.slice(4));
    const key = `open:${t.id}`;
    const m = acatMovement(t, key, cuidFor(key), dealCrmId(2000 + n));
    switch (t.status) {
      case "WaitingForStatement":
        m.nextStep = "Waiting on the client's latest statement to confirm the delivering account number.";
        m.nextStepOwner = "Client Service";
        m.extraTasks.push({ title: "Collect statements", team: "Client Service", status: "Waiting", day: m.created, assignedTo: staff.helen.name, followUpOn: ahead(2) });
        break;
      case "PendingAccountOpening":
        m.nextStep = "Apex is opening the receiving account. Submit once the account number posts.";
        m.nextStepOwner = "Client Service";
        break;
      case "ToCome":
        m.nextStep = "Log the control number once Apex assigns it.";
        m.nextStepOwner = "Operations";
        m.extraTasks.push({ title: "Record the ACAT control number", team: "Operations", status: "Ready", day: t.submissionDay!, assignedTo: staff.jordan.name, followUpOn: ahead(1) });
        break;
      case "PendingContraResponse":
        m.tracking.push({ day: addBusinessDays(t.submissionDay!, 5), stage: "Delivering firm asked for a new letter of authorization", expected: null });
        m.tracking.sort((a, b) => a.day.localeCompare(b.day));
        m.nextStep = "New letter of authorization sent after the client signed again; waiting on the delivering firm.";
        m.nextStepOwner = "Operations";
        break;
      case "PendingBookkeeping":
        m.receipt = {
          day: t.lastDay, lines: Math.max(1, t.assets.length),
          partial: { nextAction: "Wait for the remaining fund shares to post", owner: "Operations", nextCheck: ahead(1) },
        };
        m.nextStep = "Confirm the remaining shares once Apex bookkeeping posts them.";
        m.nextStepOwner = "Operations";
        break;
      case "Submitted":
        if (t.workflow === "MANUAL") {
          m.mailing = {
            day: addBusinessDays(t.submissionDay!, -1), reason: "Physical Mail", items: ["Manual Transfer Paperwork"],
            journey: "Cedar Ridge to the final destination",
            legs: [{ carrier: "USPS", tracking: `9400 1000 0000 ${seededInt(`${key}:usps`, 1000, 9999)} ${seededInt(`${key}:usps2`, 10, 99)}`, mailed: addBusinessDays(t.submissionDay!, -1), received: t.submissionDay! }],
          };
          m.nextStep = "Liquidation only: the proceeds come by check to the house account.";
          m.nextStepOwner = "Operations";
        }
        break;
      case "PendingReview":
        if (t.workflow === "DRS") {
          m.drsTasksDone = 5;
          m.nextStep = "Waiting on Apex to confirm the shares moved from the transfer agent.";
          m.nextStepOwner = "Operations";
        }
        break;
    }
    movements.push({ ...m, deal: dealFor(m, { stage: m.stage === "DECISION" ? "COMMITTED" : "FUNDING" }) });
  });

  // --- the tracker's recently finished inbound transfers, now Funded ---

  const recent = tracker.transfers
    .filter((t) => /^tr-h\d+$/.test(t.id) && t.direction === "In" && t.status === "Completed" && t.workflow !== "RESIDUAL"
      && businessDaysBetween(t.completionDay!, today) <= 20)
    .sort((a, b) => b.completionDay!.localeCompare(a.completionDay!));
  recent.forEach((t, index) => {
    const n = Number(t.id.slice(4));
    const key = `recent:${t.id}`;
    const m = acatMovement(t, key, cuidFor(key), dealCrmId(3000 + n));
    m.statement = { day: m.plan!.day, accepted: true };
    if (m.fundingType === "ACAT_FULL" || m.fundingType === "ACAT_PARTIAL") {
      m.receipt = { day: t.completionDay!, lines: Math.max(1, t.assets.length) };
    }
    if (m.fundingType === "DRS") m.drsTasksDone = 8;
    if (m.fundingType === "ACAT_PARTIAL") m.partialTasksDone = 3;
    m.funded = { day: t.completionDay!, by: staff.jordan };
    // The newest ones still have closeout work open.
    m.closeoutDone = index < 3 ? 3 + index : 7;
    m.fundedTasksDone = index < 3 ? 1 + index : 4;
    m.feeReimbursement = t.fee?.feeRequestSubmitted ?? undefined;
    if (index < 3) {
      m.nextStep = "Finish the closeout: cost basis, template and fee reimbursement.";
      m.nextStepOwner = "Operations";
    }
    movements.push({ ...m, deal: dealFor(m, { stage: "WON" }) });
  });

  // --- cash, rollovers and preparation work with no ACAT in flight ---

  // A household moving money here has no story or open ACAT of its own (a finished one, any day, is fine).
  const busy = new Set(movements.filter((m) => !m.key.startsWith("recent:")).map((m) => m.household.id));
  for (const plan of cashAndPreparation(universe, today, staff, advisorOf)) {
    if (busy.has(plan.movement.household.id)) throw new Error(`${plan.movement.household.id} already has a movement in flight`);
    movements.push({ ...plan.movement, deal: dealFor(plan.movement, plan.deal) });
  }

  return { movements, pipelineDeals: pipelineDeals(universe, today, advisorOf) };
}

type CashPlan = {
  movement: Omit<Movement, "deal">;
  deal: DealOpts;
};

function cashAndPreparation(
  universe: Universe,
  today: string,
  staff: { helen: Actor; jordan: Actor; marco: Actor },
  advisorOf: (h: UniverseHousehold) => Actor,
): CashPlan[] {
  const ago = (n: number) => addBusinessDays(today, -n);
  const ahead = (n: number) => addBusinessDays(today, n);
  let n = 0;
  const base = (householdId: string, accountId: string | null, firm: string, fundingType: FundingType, value: number,
    stage: TransferStage, createdAgo: number): Omit<Movement, "deal"> => {
    n += 1;
    const household = householdOf(universe, householdId);
    const account = accountId ? accountById(universe, accountId) : firstAccount(universe, householdId);
    const key = `cash:${householdId}`;
    return {
      key,
      transferId: cuidFor(key),
      dealSfId: dealCrmId(4000 + n),
      trackerId: null,
      acatTransferId: null,
      trackerStatus: null,
      household,
      owners: accountOwners(universe, account),
      account,
      firm,
      firmAvgDays: 6,
      sourceType: fundingType === "WIRE" || fundingType === "ACH" ? "Bank account"
        : fundingType === "CHECK" ? "Employer retirement plan" : INTAKE_TYPE[account.type] ?? "Individual",
      sourceLast4: String(seededInt(`${key}:last4`, 1000, 9999)),
      fundingType,
      stage,
      value,
      owner: { kind: "CLIENT_SERVICE", name: staff.helen.name },
      nextStep: null,
      nextStepOwner: null,
      created: ago(createdAgo),
      createdBy: staff.helen,
      clientRequest: { day: ago(createdAgo), source: "Client Service" },
      receivingOpen: ago(createdAgo),
      tracking: [],
      closeoutDone: 0,
      fundedTasksDone: 0,
      extraTasks: [],
    };
  };
  const plans: CashPlan[] = [];
  const plannedBy = (m: Omit<Movement, "deal">, day: string, by: Actor) => {
    m.statement = { day, accepted: true };
    m.match = day;
    m.plan = { day, by };
  };

  { // Kirlin: a 401(k) rollover by check, the client has mailed the check back
    const m = base("kirlin", "acct-023", "Empower / Pershing", "CHECK", 286400, "IN_TRANSFER", 12);
    m.owners = m.owners.slice(0, 1);
    m.newReceiving = { type: "Rollover IRA", open: ago(10) };
    plannedBy(m, ago(11), staff.marco);
    m.checkTicket = { day: ago(9), mailerSent: true, checkMailed: true };
    m.mailing = {
      day: ago(9), reason: "Physical Check / Deposit Slip", items: ["IRA Deposit Slip", "Return shipping label"],
      journey: "Cedar Ridge to the client to Cedar Ridge to the final destination",
      legs: [
        { carrier: "USPS", tracking: `9400 1000 0000 ${seededInt("kirlin:u1", 1000, 9999)} 21`, mailed: ago(9), received: ago(6) },
        { carrier: "USPS", tracking: `9400 1000 0000 ${seededInt("kirlin:u2", 1000, 9999)} 37`, mailed: ago(2) },
        {},
      ],
      postage: 9.85,
    };
    m.inTransfer = { day: ago(9), by: staff.marco };
    m.owner = { kind: "OPERATIONS", name: staff.marco.name };
    m.nextStep = "The rollover check is in the mail back to Cedar Ridge; deposit it on arrival.";
    m.nextStepOwner = "Operations";
    plans.push({ movement: m, deal: { stage: "FUNDING", accountType: "401(k) Rollover", rollingInto: "Traditional IRA", statements: true } });
  }
  { // Mayer: a wire from the client's bank is on its way
    const m = base("mayer", "acct-030", "Wells Fargo", "WIRE", 150000, "IN_TRANSFER", 4);
    plannedBy(m, ago(3), staff.marco);
    m.inTransfer = { day: ago(1), by: staff.marco };
    m.cashInFlight = ago(1);
    m.owner = { kind: "OPERATIONS", name: staff.marco.name };
    m.nextStep = "Wire sent from the client's bank; confirm it lands in the joint account.";
    m.nextStepOwner = "Operations";
    plans.push({ movement: m, deal: { stage: "FUNDING", accountType: "Cash" } });
  }
  { // Rice: an ACH being set up
    const m = base("rice", "acct-037", "Wells Fargo", "ACH", 25000, "DECISION", 2);
    plannedBy(m, ago(1), staff.marco);
    m.nextStep = "Send the client the ACH instructions.";
    m.nextStepOwner = "Client Service";
    m.extraTasks.push({ title: "Send the client ACH instructions", team: "Client Service", status: "Ready", day: ago(1), assignedTo: staff.helen.name, followUpOn: today });
    plans.push({ movement: m, deal: { stage: "COMMITTED", accountType: "Cash" } });
  }
  { // Kuhlman: the client started an ACH from their bank
    const m = base("kuhlman", "acct-064", "Charles Schwab", "ACH", 40000, "IN_TRANSFER", 6);
    plannedBy(m, ago(5), staff.marco);
    m.achInitiation = { day: ago(2), clientDay: ago(2) };
    m.inTransfer = { day: ago(2), by: staff.helen };
    m.owner = { kind: "OPERATIONS", name: staff.marco.name };
    m.nextStep = "Watch for the ACH to settle (three to five business days).";
    m.nextStepOwner = "Operations";
    plans.push({ movement: m, deal: { stage: "FUNDING", accountType: "Cash" } });
  }
  { // Hayes: a rollover check being prepared
    const m = base("hayes", "acct-016", "Fidelity", "CHECK", 132500, "DECISION", 3);
    plannedBy(m, ago(2), staff.marco);
    m.nextStep = "Send the rollover mailer with the IRA deposit slip.";
    m.nextStepOwner = "Client Service";
    plans.push({ movement: m, deal: { stage: "COMMITTED", accountType: "401(k) Rollover", rollingInto: "Traditional IRA" } });
  }
  { // Bode: a wire that landed last week
    const m = base("bode", "acct-041", "J.P. Morgan", "WIRE", 310000, "FUNDED", 9);
    plannedBy(m, ago(8), staff.marco);
    m.inTransfer = { day: ago(6), by: staff.marco };
    m.cashInFlight = ago(6);
    m.funded = { day: ago(5), by: staff.marco };
    m.fundedTasksDone = 4;
    m.closeoutDone = 7;
    m.owner = { kind: "OPERATIONS", name: staff.marco.name };
    plans.push({ movement: m, deal: { stage: "WON", accountType: "Cash" } });
  }
  { // Herman: an ACH that settled
    const m = base("herman", "acct-044", "Vanguard", "ACH", 60000, "FUNDED", 14);
    plannedBy(m, ago(13), staff.marco);
    m.achInitiation = { day: ago(12), clientDay: ago(12) };
    m.inTransfer = { day: ago(12), by: staff.helen };
    m.funded = { day: ago(8), by: staff.marco };
    m.fundedTasksDone = 4;
    m.closeoutDone = 7;
    m.owner = { kind: "OPERATIONS", name: staff.marco.name };
    plans.push({ movement: m, deal: { stage: "WON", accountType: "Cash" } });
  }
  { // Carroll: deferred until after the year-end distribution
    const m = base("carroll", "acct-047", "Charles Schwab", "ACAT_FULL", 412000, "DECISION", 28);
    plannedBy(m, ago(26), staff.jordan);
    m.outcome = {
      day: ago(24), outcome: "Deferred", reason: "Client asked to wait until after the year-end distribution.",
      followUpOn: addCalendarDays(`${Number(today.slice(0, 4)) + 1}-01-05`, 0),
    };
    m.nextStep = "Paused: restart after the client's year-end distribution.";
    m.nextStepOwner = "Client Service";
    plans.push({ movement: m, deal: { stage: "COMMITTED", potentialDays: 30 } });
  }
  { // Walker: just committed; intake done, nothing else yet
    const m = base("walker", "acct-062", "Vanguard", "ACAT_FULL", 1306500, "DECISION", 0);
    m.nextStep = "Collect the latest Vanguard statement and run the asset mapper.";
    m.nextStepOwner = "Client Service";
    plans.push({ movement: m, deal: { stage: "COMMITTED" } });
  }
  { // Cole: a partial ACAT waiting on the advisor's position decisions
    const m = base("cole", "acct-080", "Wells Fargo", "ACAT_PARTIAL", 455000, "DECISION", 5);
    m.statement = { day: ago(4), accepted: true };
    m.match = ago(4);
    const holdings = universe.holdings.filter((h) => h.account === "acct-080").slice(0, 4);
    m.extraTasks.push({ title: "Advisor to decide which positions come over", team: "Operations / Client Service", status: "Waiting", day: ago(3), assignedTo: "Rachel Moss", followUpOn: ahead(2) });
    m.owner = { kind: "ADVISOR", name: advisorOf(m.household).name };
    m.nextStep = "Advisor reviews the decision worksheet with the client.";
    m.nextStepOwner = "Advisor";
    // The worksheet: the account's holdings, valued from the statement, none decided yet.
    m.worksheet = holdings.map((h) => {
      const security = universe.securities.find((s) => s.symbol === h.symbol);
      return {
        symbol: h.symbol, description: security?.name ?? h.symbol, value: round2(h.value * 0.5),
        basis: round2(h.value * 0.5 * (0.5 + 0.4 * seeded(`cole:${h.symbol}`))), decision: "UNDECIDED",
      } satisfies PlannedDecision;
    });
    plans.push({ movement: m, deal: { stage: "COMMITTED" } });
  }
  { // Rosenbaum: the client stayed with Merrill; the deal was lost and the sync archived the transfer
    const m = base("rosenbaum", "acct-093", "Merrill Lynch", "ACAT_FULL", 550050, "DECISION", 18);
    m.statement = { day: ago(17), accepted: true };
    m.match = ago(17);
    m.archived = { day: ago(9), reason: "deal_lost" };
    plans.push({ movement: m, deal: { stage: "LOST", lostFrom: "COMMITTED" } });
  }
  { // Delgado: a revocable trust; the trust certification is still needed before the statement is accepted
    const m = base("delgado-trust", null, "Charles Schwab", "ACAT_FULL", 0, "DECISION", 7);
    m.value = 845000;
    m.sourceType = "Trust";
    m.statement = { day: ago(6), accepted: false };
    m.nextStep = "Get the trust certification so the Schwab trust statement can be accepted.";
    m.nextStepOwner = "Client Service";
    m.extraTasks.push({ title: "Collect the trust certification for the Delgado Family Trust", team: "Client Service", status: "Waiting", day: ago(6), assignedTo: staff.helen.name, followUpOn: ahead(2) });
    plans.push({ movement: m, deal: { stage: "COMMITTED", statements: false, accountType: "Trust" } });
  }
  { // Friesen: the advisor moved the deal back to Potential after work had started; the sync flagged the transfer
    const m = base("friesen", "acct-033", "T. Rowe Price / Pershing", "ACAT_FULL", 1215200, "DECISION", 10);
    plannedBy(m, ago(9), staff.jordan);
    m.syncFlag = "uncommitted_review";
    m.nextStep = "Deal moved back to Potential: confirm with the advisor whether this transfer stays open.";
    m.nextStepOwner = "Operations";
    plans.push({ movement: m, deal: { stage: "POTENTIAL" } });
  }

  return plans;
}

/** Deals with no movement of their own. */
function pipelineDeals(universe: Universe, today: string, advisorOf: (h: UniverseHousehold) => Actor): DealPlan[] {
  const potentials: Array<[string, string | null, string, string, number, number]> = [
    // household, account id (null: a new account; the household's second member), firm, deal funding type, amount,
    // business days open
    ["schmeler", null, "Empower / Pershing", "401(k) Rollover", 452000, 9],
    ["alvarez", "acct-002", "Vanguard", "Roth IRA", 95000, 14],
    ["okafor", null, "Fidelity", "401(k) Rollover", 182500, 6],
    ["howell", "acct-055", "Morgan Stanley", "Individual Brokerage", 240000, 41],
    ["crooks", "acct-070", "Edward Jones", "Traditional IRA", 315000, 18],
    ["harvey", "acct-076", "Charles Schwab", "Individual Brokerage", 128000, 3],
    ["reichert", "acct-089", "UBS", "JT WROS", 410000, 37],
    ["lindqvist", "acct-008", "Fidelity", "Individual Brokerage", 58200, 25],
  ];
  const lost: Array<[string, string, string, string, number, number]> = [
    ["ohara", "acct-053", "Morgan Stanley", "Roth IRA", 210000, 34],
    ["nikolaus", "acct-085", "Vanguard", "Traditional IRA", 113400, 22],
  ];
  const deals: DealPlan[] = [];
  potentials.forEach(([hh, acct, firm, type, amount, open], i) => {
    const household = householdOf(universe, hh);
    const account = acct ? accountById(universe, acct) : null;
    const members = universe.people.filter((p) => p.household === hh);
    const client = account ? accountOwners(universe, account)[0] : members[1] ?? members[0];
    const created = addBusinessDays(today, -open);
    deals.push({
      sfDealId: dealCrmId(5001 + i), household, client, account, firm, accountType: type,
      last4: String(seededInt(`potential:${hh}:last4`, 1000, 9999)), amount, stage: "POTENTIAL",
      history: [{ stage: "POTENTIAL", from: null, day: created, by: CRM_FEED }],
      closeDay: addCalendarDays(created, 45), lastActivity: addBusinessDays(created, Math.min(open, 2)),
      statements: false, assetMapped: false, rollingInto: type === "401(k) Rollover" ? "Traditional IRA" : null,
    });
  });
  lost.forEach(([hh, acct, firm, type, amount, open], i) => {
    const household = householdOf(universe, hh);
    const account = accountById(universe, acct);
    const created = addBusinessDays(today, -open);
    const lostDay = addBusinessDays(created, Math.max(1, open - 5));
    deals.push({
      sfDealId: dealCrmId(6001 + i), household, client: accountOwners(universe, account)[0], account, firm, accountType: type,
      last4: String(seededInt(`lost:${hh}:last4`, 1000, 9999)), amount, stage: "LOST",
      history: [
        { stage: "POTENTIAL", from: null, day: created, by: CRM_FEED },
        { stage: "LOST", from: "POTENTIAL", day: lostDay, by: advisorOf(household) },
      ],
      closeDay: lostDay, lastActivity: lostDay, statements: false, assetMapped: false, lostFrom: "POTENTIAL",
    });
  });
  return deals;
}
