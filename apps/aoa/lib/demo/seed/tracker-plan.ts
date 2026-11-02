// The Transfer Tracker demo's plan of transfers (apps/acat/src/lib/demo/seed.ts, planDemoTransfers), ported so the
// demo's ACAT book holds the same records as the tracker demo for the same `now`: the nine universe stories, about
// nine months of finished history, the residual credits after them, and one in-flight transfer per working status.
// Same draws, same calendar, same ids (tr-t298, tr-h001…, tr-o01…, tr-h…-r), statuses, dates, amounts, assets, fees
// and control numbers. Pure: no database.

import { addBusinessDays, businessDayOnOrBefore, businessDaysBetween, firmToday } from "./calendar";
import { CUSTODIAN_LIBRARY, type LibraryCustodian, type LibraryFee } from "./tracker-library";
import { pick, seeded, seededInt, type Universe, type UniverseAccount, type UniverseStatementPosition, type UniverseTransferStory } from "./universe";

export type PlanStatus =
  | "WaitingForApex" | "PendingAccountOpening" | "WaitingOnClient" | "WaitingForStatement" | "AcatReceived" | "ToCome"
  | "Submitted" | "PendingReview" | "PendingContraResponse" | "Accepted" | "PendingSettlement" | "PendingBookkeeping"
  | "Completed" | "Rejected" | "Purged" | "Canceled" | "Deferred";
export type PlanWorkflow = "ACAT" | "MANUAL" | "DRS" | "RESIDUAL";
export type PlanMapStatus = "Mapped" | "Unmapped" | "Pending" | "Expected";

// --- delivering firms ---

type DemoFee = Omit<LibraryFee, "accountType" | "transferType" | "direction"> &
  Partial<Pick<LibraryFee, "accountType" | "transferType" | "direction">>;

export interface DemoFirm extends Omit<LibraryCustodian, "fees"> {
  prefix: string; // delivering account numbers start with it
  universeId?: string;
  avgDays: number;
  receivingAccountNumber?: string;
  fees: DemoFee[];
  feeSummary?: boolean; // store a fee-summary PDF as the firm's fee-schedule document
  // Share of the generated history, per workflow.
  weight: Partial<Record<"ACAT" | "MANUAL" | "DRS", number>>;
}

// What the demo adds to each firm in the custodian library: the prefix its delivering account numbers start
// with, a typical processing time, and its share of the generated history. Apex receives every transfer and
// Pershing is a reference card, so neither delivers one.
const DEMO_SETTINGS: Record<string, Pick<DemoFirm, "prefix" | "avgDays" | "weight" | "receivingAccountNumber" | "feeSummary">> = {
  "Acorns": { prefix: "ACO", avgDays: 12, weight: { MANUAL: 2 } },
  "Ameriprise Financial Services": { prefix: "AMP", avgDays: 7, weight: { ACAT: 1 } },
  "Apex": { prefix: "APX", avgDays: 7, weight: {} },
  "Axos": { prefix: "AXS", avgDays: 6, weight: { ACAT: 1 } },
  "BNY Investments": { prefix: "BNY", avgDays: 15, weight: { MANUAL: 4 } },
  "Betterment/Apex": { prefix: "BTM", avgDays: 9, weight: { MANUAL: 2 } },
  "Charles Schwab": { prefix: "SCH", avgDays: 6, weight: { ACAT: 8 }, feeSummary: true },
  "Computershare": { prefix: "CPU", avgDays: 12, weight: { DRS: 1 } },
  "DriveWealth": { prefix: "DWT", avgDays: 6, weight: { ACAT: 1 } },
  "E*Trade": { prefix: "ETR", avgDays: 6, weight: { ACAT: 3 } },
  "Edward Jones": { prefix: "EDJ", avgDays: 5, weight: { ACAT: 9 }, feeSummary: true },
  "Empower / Pershing": { prefix: "EMP", avgDays: 9, weight: { ACAT: 2 } },
  "Equiniti Trust Company": { prefix: "EQT", avgDays: 12, weight: { DRS: 1 } },
  "Fidelity": { prefix: "FID", avgDays: 7, weight: { ACAT: 6 }, feeSummary: true },
  "First Command": { prefix: "FCM", avgDays: 8, weight: { ACAT: 1 } },
  "First Command Custodied through Fidelity": { prefix: "FCF", avgDays: 16, weight: { MANUAL: 1 } },
  "Frec": { prefix: "FRC", avgDays: 5, weight: { ACAT: 1 } },
  "Independent Financial Partners / Pershing": { prefix: "IFP", avgDays: 7, weight: { ACAT: 1 } },
  "Interactive Brokers": { prefix: "IBK", avgDays: 6, weight: { ACAT: 1 } },
  "J.P. Morgan": { prefix: "JPM", avgDays: 9, weight: { ACAT: 1 } },
  "LPL Financial": { prefix: "LPL", avgDays: 8, weight: { ACAT: 1 } },
  "Merrill Lynch": { prefix: "MER", avgDays: 6, weight: { ACAT: 2 } },
  "Morgan Stanley": { prefix: "MSW", avgDays: 7, weight: { ACAT: 2 } },
  "Northwestern Mutual": { prefix: "NWM", avgDays: 8, weight: { ACAT: 1 } },
  "Pershing": { prefix: "PSH", avgDays: 8, weight: {} },
  "RBC Wealth Management": { prefix: "RBC", avgDays: 7, weight: { ACAT: 1 } },
  "Robinhood": { prefix: "RHD", avgDays: 5, weight: { ACAT: 2 } },
  "Sparrow Growth Funds": { prefix: "SPG", avgDays: 15, weight: { MANUAL: 1 } },
  "T. Rowe Price / Pershing": { prefix: "TRP", avgDays: 12, weight: { MANUAL: 2 } },
  "The Capital Group": { prefix: "CPG", avgDays: 22, weight: { MANUAL: 1 } },
  "UBS": { prefix: "UBS", avgDays: 7, weight: { ACAT: 1 } },
  "Vanguard": { prefix: "VGD", avgDays: 6, weight: { ACAT: 2 } },
  "Victory Funds": { prefix: "VIC", avgDays: 25, weight: { MANUAL: 3 }, receivingAccountNumber: "DEMOOMNI01", feeSummary: true },
  "WealthFront": { prefix: "WLF", avgDays: 5, weight: { ACAT: 2 } },
  "Wells Fargo": { prefix: "WFC", avgDays: 8, weight: { ACAT: 1 } },
};

// A second Edward Jones card, made when someone typed the contra by hand. The tracker demo's admin merges it.
export const DUPLICATE_FIRM = "Edward Jones & Co";

export function demoFirms(universe: Universe): DemoFirm[] {
  const firms = CUSTODIAN_LIBRARY.map((custodian): DemoFirm => {
    const settings = DEMO_SETTINGS[custodian.name];
    if (!settings) throw new Error(`No demo settings for ${custodian.name}`);
    return { ...custodian, ...settings, universeId: universe.custodians.find((c) => c.name === custodian.name)?.id };
  });
  for (const c of universe.custodians) {
    if (!firms.some((f) => f.universeId === c.id)) throw new Error(`The universe's ${c.name} is not in the custodian library`);
  }
  const original = firms.find((f) => f.name === "Edward Jones")!;
  firms.push({
    name: DUPLICATE_FIRM, prefix: "EDC", transferType: "ACAT_API", documentation: "NEEDS_CALL", review: "NEEDS_SETUP",
    dtc: original.dtc, avgDays: original.avgDays, fees: [], weight: {},
  });
  return firms;
}

/** The firm's custodian id, as the tracker demo keys it and AoA's authority keeps it. */
export const firmCustodianId = (firm: Pick<DemoFirm, "prefix">): string => `cust-${firm.prefix.toLowerCase()}`;

/** The firm's DTC number as a transfer records it: the first four digits of the library's note. */
export const clearingNumber = (firm: DemoFirm): string | null => firm.dtc?.match(/\d{4}/)?.[0] ?? null;

// --- the tracker's account types and owners (apps/acat/src/lib/demo/universe.ts) ---

export const TRACKER_ACCOUNT_TYPE: Record<string, string> = {
  "joint-taxable": "Joint Account (JTWROS - Rights of Survivorship)",
  individual: "Brokerage / Individual",
  trust: "Other",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Traditional IRA",
  "sep-ira": "Traditional IRA",
  "roth-ira": "Roth IRA",
};

/** The advisor's first name, as the tracker's advisor field stores it. */
export function advisorFirstName(universe: Universe, householdId: string): string {
  const advisorId = universe.households.find((h) => h.id === householdId)?.advisor;
  return universe.staff.find((s) => s.id === advisorId)?.name.split(" ")[0] ?? "None";
}

// --- transfers ---

export interface PlannedAsset {
  symbol: string;
  description: string;
  expectedQty: number;
  actualQty: number;
  mapStatus: PlanMapStatus;
  amount: number;
  assetClass: string | null;
  issue?: string;
  notes?: string;
  liquidate?: boolean;
}

export interface FeePlan {
  feeCharged?: string | null;
  feeAmount?: string | null;
  feeMemo?: string | null;
  feeRequestSubmitted?: string | null;
  feeRequestCompleted?: string | null;
  feeCreditRequestId?: string | null;
  feeApexTicket?: string | null;
}

export interface PlannedTransfer {
  id: string;
  storyId?: string;
  acatTransferId?: string;
  parentId?: string;
  household: string;
  account: UniverseAccount;
  firm: DemoFirm;
  workflow: PlanWorkflow;
  direction: "In" | "Out";
  type: "Full" | "Partial" | "Residual Credit";
  method: string;
  status: PlanStatus;
  value: number; // dollars, positive
  requestDay: string;
  submissionDay: string | null;
  completionDay: string | null;
  lastDay: string; // day of the latest change
  controlNumber: string | null;
  associatedControlNumber?: string;
  dtcBlank?: boolean;
  notes?: string;
  rejectionReason?: string;
  tradeInstructions?: string | null;
  residualMonitoring?: boolean;
  residualFollowUpDay?: string;
  feeStage?: "none" | "unsubmitted" | "submitted" | "completed";
  assets: PlannedAsset[];
  reconComplete?: boolean;
  statement?: { periodEnd: string; stale: boolean };
  statementAccountNumber?: string | null;
  fee?: FeePlan;
  documents: Array<"TRANSFER_FORM" | "MAPPING_CSV">;
  formSelection?: "BROKERAGE_FIRM_TRANSFER" | "PARTIAL_TRANSFER" | "NON_ACAT_TRANSFER";
  formInstruction?: "IN_KIND" | "MIXED";
}

const TRADE_INSTRUCTIONS = [
  "Keep positions in kind. Rebalance to the household model after settlement.",
  "Sell the legacy mutual funds after settlement and invest per the model.",
  "Hold in kind. The client wants to review the concentrated position with the advisor first.",
  "Liquidate all positions after settlement and invest per the model.",
  "Keep the ETFs, sell the individual stocks over two weeks to manage gains.",
];
const REJECTION_REASONS = [
  "Account title mismatch: the delivering account includes a middle initial.",
  "Delivering account number not found at the contra.",
  "Open margin balance at the delivering firm.",
  "Duplicate request: an earlier transfer for this account is still open.",
  "Tax ID on the request does not match the delivering account.",
];

export const money = (dollars: number): string => `$${dollars.toFixed(2)}`;

function accountOf(universe: Universe, id: string): UniverseAccount {
  const account = universe.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`universe account ${id} not found`);
  return account;
}

/** Positions for a transfer: the receiving account's holdings, scaled to the transfer's value. */
export function assetsFromHoldings(universe: Universe, account: UniverseAccount, value: number, mapStatus: PlanMapStatus, key: string): PlannedAsset[] {
  const holdings = universe.holdings.filter((h) => h.account === account.id);
  const total = holdings.reduce((sum, h) => sum + h.value, 0) || 1;
  const factor = value / total;
  return holdings.map((h, index) => {
    const security = universe.securities.find((s) => s.symbol === h.symbol);
    const fund = security?.vehicle === "mutual-fund";
    const raw = h.quantity * factor;
    const qty = fund ? Math.round(raw * 1000) / 1000 : Math.max(1, Math.round(raw));
    const settled = mapStatus === "Mapped";
    return {
      symbol: h.symbol,
      description: security?.name ?? h.symbol,
      expectedQty: qty,
      actualQty: settled ? qty : 0,
      mapStatus,
      amount: Math.round(h.value * factor * 100) / 100,
      assetClass: security?.assetClass ?? null,
      ...(index === 0 && seeded(`${key}:cash`) < 0.15 ? { notes: "Dividend reinvested before the transfer." } : {}),
    };
  });
}

function assetsFromStatement(universe: Universe, positions: UniverseStatementPosition[], liquidate: string[]): PlannedAsset[] {
  return positions.map((p) => {
    const security = universe.securities.find((s) => s.symbol === p.symbol);
    const isCash = p.symbol === "CASH";
    const qty = isCash ? p.value : Number(p.quantity);
    return {
      symbol: p.symbol,
      description: isCash ? "Cash and money market" : security?.name ?? p.symbol,
      expectedQty: qty,
      actualQty: 0,
      mapStatus: "Pending",
      amount: p.value,
      assetClass: isCash ? "cash" : security?.assetClass ?? null,
      ...(liquidate.includes(p.symbol)
        ? { liquidate: true, notes: "Sells first at the delivering firm. Proceeds arrive as cash." }
        : {}),
    };
  });
}

/** The nine universe stories, placed relative to today. */
function storyTransfers(universe: Universe, firmsById: Map<string, DemoFirm>, today: string): PlannedTransfer[] {
  const asOf = businessDayOnOrBefore(universe.meta.asOf);
  // Receiving account for households with more than one Apex account.
  const ACCOUNT_FOR: Record<string, string> = { brennan: "acct-009", lindqvist: "acct-007", alvarez: "acct-001" };
  const STATUS: Record<UniverseTransferStory["stage"], PlanStatus> = {
    paperwork: "WaitingOnClient",
    submitted: "Submitted",
    "in-transfer": "Accepted",
    completed: "Completed",
    exception: "Rejected",
  };
  return universe.stories.transfers.map((story) => {
    const firm = firmsById.get(story.from)!;
    const accountId = ACCOUNT_FOR[story.household] ?? universe.accounts.find((a) => a.household === story.household)!.id;
    const account = accountOf(universe, accountId);
    const manual = firm.transferType === "MANUAL";
    const days = story.daysInStage ?? 0;
    let requestDay: string;
    let submissionDay: string | null = null;
    let completionDay: string | null = null;
    let status = STATUS[story.stage];
    if (story.stage === "paperwork") {
      requestDay = addBusinessDays(today, -days);
    } else if (story.stage === "completed") {
      completionDay = addBusinessDays(today, -businessDaysBetween(story.completed!, asOf));
      submissionDay = addBusinessDays(completionDay, -firm.avgDays);
      requestDay = addBusinessDays(submissionDay, -2);
    } else {
      // Submitted: in stage since submission. In transfer and exceptions: accepted or rejected
      // `days` ago, two business days after submission.
      const stageStart = addBusinessDays(today, -days);
      submissionDay = story.stage === "submitted" ? stageStart : addBusinessDays(stageStart, -2);
      requestDay = addBusinessDays(submissionDay, -2);
    }
    if (story.id === "T-298") status = "PendingSettlement";

    const statement = story.statement ? universe.stories.statements.find((s) => s.id === story.statement) : undefined;
    const statementAccount = statement?.accounts?.[0];
    const partial = story.flag?.startsWith("Partial") ?? false;
    let assets: PlannedAsset[];
    if (statementAccount) {
      assets = assetsFromStatement(universe, statementAccount.positions, partial ? ["BBGLX"] : []);
    } else {
      const mapStatus: PlanMapStatus = story.stage === "completed" ? "Mapped" : "Pending";
      assets = assetsFromHoldings(universe, account, story.value, mapStatus, story.id);
    }
    // One completed story keeps a fractional-share difference for recon review.
    if (story.id === "T-280" && assets.length > 1) {
      const short = assets[assets.length - 1];
      short.actualQty = Math.max(0, short.expectedQty - 1);
      short.mapStatus = "Unmapped";
      short.issue = "Qty Mismatch (-1 share)";
    }
    const staleStatement = universe.stories.statements.find((s) => s.household === story.household && s.custodian === story.from && !s.accounts);

    const documents: PlannedTransfer["documents"] = [];
    if (story.stage !== "exception") documents.push("TRANSFER_FORM");
    if (statementAccount || story.stage === "completed") documents.push("MAPPING_CSV");

    return {
      id: `tr-${story.id.toLowerCase().replace("-", "")}`,
      storyId: story.id,
      household: story.household,
      account,
      firm,
      workflow: manual ? "MANUAL" : "ACAT",
      direction: "In",
      type: partial ? "Partial" : "Full",
      method: manual ? "Non-ACAT Transfer (Manual)" : story.stage === "paperwork" ? "Full Docusign" : partial ? "Partial Docusign" : "API",
      status,
      value: story.value,
      requestDay,
      submissionDay,
      completionDay,
      lastDay: completionDay ?? (story.stage === "paperwork" ? requestDay : addBusinessDays(today, -days)),
      controlNumber: story.control ?? null,
      notes: story.flag && !partial ? story.flag : undefined,
      rejectionReason: story.stage === "exception" ? "Name mismatch: the delivering account is titled with a Jr. suffix." : undefined,
      tradeInstructions: partial
        ? "Partial transfer: move VTI, MSFT, AAPL and BND in kind. Edward Jones sells BBGLX first and sends the proceeds as cash."
        : story.stage === "exception" ? null : TRADE_INSTRUCTIONS[seededInt(`${story.id}:ti`, 0, TRADE_INSTRUCTIONS.length - 1)],
      residualMonitoring: story.stage === "completed",
      residualFollowUpDay: story.stage === "completed" ? addBusinessDays(completionDay!, 15) : undefined,
      feeStage: story.stage === "completed" ? "submitted" : "none",
      assets,
      reconComplete: story.stage === "completed" && story.id !== "T-280",
      statement: statement
        ? { periodEnd: statement.periodEnd, stale: false }
        : staleStatement ? { periodEnd: staleStatement.periodEnd, stale: true } : undefined,
      documents,
      formSelection: manual ? "NON_ACAT_TRANSFER" : partial ? "PARTIAL_TRANSFER" : "BROKERAGE_FIRM_TRANSFER",
      formInstruction: partial ? "MIXED" : "IN_KIND",
    };
  });
}

function weightedFirm(firms: DemoFirm[], workflow: "ACAT" | "MANUAL" | "DRS", key: string): DemoFirm {
  const pool = firms.filter((f) => (f.weight[workflow] ?? 0) > 0);
  const total = pool.reduce((sum, f) => sum + f.weight[workflow]!, 0);
  let draw = seeded(key) * total;
  for (const firm of pool) {
    draw -= firm.weight[workflow]!;
    if (draw < 0) return firm;
  }
  return pool[pool.length - 1];
}

const HISTORY_COUNT = 92;
const HISTORY_SPAN_DAYS = 180;

/** About nine months of finished transfers across every workflow, with realistic per-firm timing. */
function historicalTransfers(universe: Universe, firms: DemoFirm[], today: string): PlannedTransfer[] {
  const households = universe.households;
  const transfers: PlannedTransfer[] = [];
  for (let i = 0; i < HISTORY_COUNT; i++) {
    const key = `hist-${i}`;
    const household = pick(`${key}:hh`, households);
    const accounts = universe.accounts.filter((a) => a.household === household.id);
    const account = pick(`${key}:acct`, accounts);
    const draw = seeded(`${key}:wf`);
    const workflow: PlanWorkflow = draw < 0.74 ? "ACAT" : draw < 0.92 ? "MANUAL" : "DRS";
    const firm = weightedFirm(firms, workflow as "ACAT" | "MANUAL" | "DRS", `${key}:firm`);
    const outgoing = workflow === "ACAT" && seeded(`${key}:dir`) < 0.1;
    const partial = workflow !== "DRS" && seeded(`${key}:partial`) < 0.2;
    const outcome = seeded(`${key}:outcome`);
    const status: PlanStatus = outcome < 0.05 ? "Rejected" : outcome < 0.08 ? "Canceled" : outcome < 0.09 ? "Deferred" : "Completed";

    const age = 3 + Math.floor((i * HISTORY_SPAN_DAYS) / HISTORY_COUNT) + seededInt(`${key}:age`, 0, 3);
    const anchor = addBusinessDays(today, -age);
    const jitter = workflow === "ACAT" ? seededInt(`${key}:dur`, -2, 3) : seededInt(`${key}:dur`, -4, 8);
    const duration = Math.max(2, (workflow === "DRS" ? 12 : firm.avgDays) + jitter);
    const prep = workflow === "ACAT" ? seededInt(`${key}:prep`, 1, 4) : seededInt(`${key}:prep`, 2, 8);

    let requestDay: string;
    let submissionDay: string | null;
    let completionDay: string | null = null;
    let lastDay: string;
    if (status === "Completed") {
      completionDay = anchor;
      submissionDay = addBusinessDays(anchor, -duration);
      requestDay = addBusinessDays(submissionDay, -prep);
      lastDay = completionDay;
    } else if (status === "Rejected") {
      submissionDay = anchor;
      requestDay = addBusinessDays(anchor, -prep);
      lastDay = addBusinessDays(anchor, seededInt(`${key}:rej`, 2, 5));
    } else {
      submissionDay = null;
      requestDay = anchor;
      lastDay = addBusinessDays(anchor, seededInt(`${key}:stop`, 3, 9));
    }

    const value = Math.round(account.value * (0.25 + 0.7 * seeded(`${key}:value`)));
    const settled = status === "Completed";
    const assets = status === "Canceled" || status === "Deferred" ? [] : assetsFromHoldings(universe, account, value, settled ? "Mapped" : "Pending", key);

    transfers.push({
      id: `tr-h${String(i + 1).padStart(3, "0")}`,
      household: household.id,
      account,
      firm,
      workflow,
      direction: outgoing ? "Out" : "In",
      type: partial ? "Partial" : "Full",
      method: workflow === "MANUAL" ? "Non-ACAT Transfer (Manual)" : workflow === "DRS" ? "N/A" : seeded(`${key}:method`) < 0.7 ? "API" : partial ? "Partial Docusign" : "Full Docusign",
      status,
      value,
      requestDay,
      submissionDay,
      completionDay,
      lastDay,
      controlNumber: null,
      notes:
        status === "Canceled" ? `Client decided to keep the account at ${firm.name}.`
        : status === "Deferred" ? "Client asked to wait until after the year-end distribution."
        : undefined,
      rejectionReason: status === "Rejected" ? pick(`${key}:reason`, REJECTION_REASONS) : undefined,
      tradeInstructions: status === "Completed" ? TRADE_INSTRUCTIONS[seededInt(`${key}:ti`, 0, TRADE_INSTRUCTIONS.length - 1)] : null,
      feeStage: status !== "Completed" ? "none" : age < 8 ? "unsubmitted" : age < 16 ? "submitted" : "completed",
      assets,
      reconComplete: settled,
      documents: settled && seeded(`${key}:doc`) < 0.4 ? ["MAPPING_CSV"] : [],
    });
  }
  return transfers;
}

/** Residual credits after finished transfers, plus monitored transfers still waiting for theirs. */
function residualTransfers(history: PlannedTransfer[], today: string): PlannedTransfer[] {
  const parents = history.filter(
    (t) => t.status === "Completed" && t.workflow === "ACAT" && t.direction === "In" && t.type === "Full"
      && businessDaysBetween(t.completionDay!, today) >= 25,
  );
  const residuals: PlannedTransfer[] = [];
  parents.forEach((parent, index) => {
    parent.residualMonitoring = true;
    parent.residualFollowUpDay = addBusinessDays(parent.completionDay!, 15);
    // Two monitored transfers never got their residual: they show in the residual sweep.
    if (index === 3 || index === 9) return;
    if (residuals.length >= 12) {
      parent.residualMonitoring = false;
      parent.residualFollowUpDay = undefined;
      return;
    }
    const key = `${parent.id}:residual`;
    const completionDay = addBusinessDays(parent.completionDay!, seededInt(key, 6, 14));
    residuals.push({
      ...parent,
      id: `${parent.id}-r`,
      workflow: "RESIDUAL",
      type: "Residual Credit",
      method: "API",
      status: "Completed",
      value: seededInt(`${key}:value`, 12, 480) + seededInt(`${key}:cents`, 0, 99) / 100,
      requestDay: addBusinessDays(parent.completionDay!, 3),
      submissionDay: addBusinessDays(parent.completionDay!, 3),
      completionDay,
      lastDay: completionDay,
      controlNumber: null,
      associatedControlNumber: undefined,
      notes: "Dividend paid to the old account after the transfer.",
      tradeInstructions: null,
      residualMonitoring: false,
      residualFollowUpDay: undefined,
      feeStage: "none",
      assets: [],
      reconComplete: false,
      documents: [],
      parentId: parent.id,
    });
  });
  return residuals;
}

/** Transfers in flight beyond the universe stories, one per working status. */
function openTransfers(universe: Universe, firmsByName: Map<string, DemoFirm>, today: string): PlannedTransfer[] {
  const quiet = universe.households.filter((h) => !h.story);
  const plans: Array<{
    firm: string; status: PlanStatus; requestAgo: number; submittedAgo: number | null; workflow?: PlanWorkflow;
    direction?: "In" | "Out"; type?: "Full" | "Partial"; method?: string; notes?: string; noInstructions?: boolean;
    dtcBlank?: boolean; control?: string | null;
  }> = [
    { firm: "Vanguard", status: "WaitingForStatement", requestAgo: 3, submittedAgo: null, method: "Full Docusign",
      notes: "Waiting on the client's latest statement to confirm the delivering account number.", noInstructions: true },
    { firm: "Merrill Lynch", status: "PendingAccountOpening", requestAgo: 2, submittedAgo: null, method: "API",
      notes: "Apex is opening the receiving IRA. Submit once the account number posts." },
    { firm: "Robinhood", status: "WaitingForApex", requestAgo: 5, submittedAgo: 3, method: "API" },
    { firm: "Edward Jones", status: "ToCome", requestAgo: 3, submittedAgo: 1, control: "To Come", method: "API" },
    { firm: "Charles Schwab", status: "PendingReview", requestAgo: 8, submittedAgo: 6, method: "API" },
    { firm: "UBS", status: "PendingContraResponse", requestAgo: 14, submittedAgo: 12, method: "API",
      notes: "Contra asked for a new letter of authorization. Resent after the client signed again." },
    { firm: "Morgan Stanley", status: "Accepted", requestAgo: 6, submittedAgo: 4, method: "API", dtcBlank: true, noInstructions: true },
    { firm: "Fidelity", status: "PendingBookkeeping", requestAgo: 12, submittedAgo: 9, method: "API" },
    { firm: "Victory Funds", status: "Submitted", requestAgo: 12, submittedAgo: 8, workflow: "MANUAL", method: "Non-ACAT Transfer (Manual)",
      notes: "Liquidation only. Proceeds come by check to the house account." },
    { firm: "Computershare", status: "PendingReview", requestAgo: 9, submittedAgo: 5, workflow: "DRS", method: "N/A",
      notes: "DRS shares held at the transfer agent. Medallion guarantee sent with the request." },
    { firm: "LPL Financial", status: "Submitted", requestAgo: 3, submittedAgo: 2, direction: "Out", method: "API",
      notes: "Client is moving the account to a bank-affiliated advisor." },
  ];
  // One household per in-flight transfer, so no client is both arriving and leaving.
  const used = new Set<string>();
  return plans.map((plan, index) => {
    const key = `open-${index}`;
    let slot = (index * 3 + 1) % quiet.length;
    while (used.has(quiet[slot].id)) slot = (slot + 1) % quiet.length;
    const household = quiet[slot];
    used.add(household.id);
    const account = universe.accounts.find((a) => a.household === household.id)!;
    const firm = firmsByName.get(plan.firm)!;
    const value = Math.round(account.value * (0.4 + 0.5 * seeded(`${key}:value`)));
    const submissionDay = plan.submittedAgo == null ? null : addBusinessDays(today, -plan.submittedAgo);
    const workflow = plan.workflow ?? "ACAT";
    return {
      id: `tr-o${String(index + 1).padStart(2, "0")}`,
      household: household.id,
      account,
      firm,
      workflow,
      direction: plan.direction ?? "In",
      type: plan.type ?? "Full",
      method: plan.method ?? "API",
      status: plan.status,
      value,
      requestDay: addBusinessDays(today, -plan.requestAgo),
      submissionDay,
      completionDay: null,
      lastDay: submissionDay ?? addBusinessDays(today, -plan.requestAgo),
      controlNumber: plan.control === undefined ? null : plan.control,
      dtcBlank: plan.dtcBlank,
      notes: plan.notes,
      tradeInstructions: plan.noInstructions || plan.direction === "Out" ? null : TRADE_INSTRUCTIONS[seededInt(`${key}:ti`, 0, TRADE_INSTRUCTIONS.length - 1)],
      feeStage: "none",
      assets: plan.status === "WaitingForStatement" || plan.status === "PendingAccountOpening" || plan.direction === "Out"
        ? [] : assetsFromHoldings(universe, account, value, "Pending", key),
      reconComplete: false,
      documents: [],
    };
  });
}

// --- numbering ---

/** Control numbers and transfer ids that grow with time and never reuse a story's. */
function assignNumbers(transfers: PlannedTransfer[]): void {
  const storyControls = new Set(transfers.filter((t) => t.storyId && t.controlNumber).map((t) => t.controlNumber!));
  const storyIds = new Set(transfers.filter((t) => t.storyId).map((t) => Number(t.storyId!.slice(2))));
  const byDate = [...transfers].sort((a, b) =>
    (a.submissionDay ?? a.requestDay).localeCompare(b.submissionDay ?? b.requestDay) || a.id.localeCompare(b.id));

  let control = 10100;
  let transferNumber = 170;
  const parentControl = new Map<string, string>();
  for (const t of byDate) {
    if (!t.storyId) {
      while (storyIds.has(transferNumber)) transferNumber++;
      t.acatTransferId = `T-${transferNumber++}`;
    }
    const needsControl = !t.storyId && t.controlNumber == null && t.submissionDay != null
      && (t.workflow === "ACAT" || t.workflow === "RESIDUAL");
    if (!needsControl) continue;
    do control += t.workflow === "RESIDUAL" ? 1 : seededInt(`${t.id}:ctl`, 2, 4);
    while (storyControls.has(`CTL-${control}`));
    t.controlNumber = `CTL-${control}`;
  }
  for (const t of transfers) if (t.controlNumber) parentControl.set(t.id, t.controlNumber);
  for (const t of transfers) {
    if (t.parentId) t.associatedControlNumber = parentControl.get(t.parentId);
  }
}

// --- fees ---

interface FeeRow { feeType: string; accountType: string; transferType: string; direction: string; amount: number | null; amountText?: string | null }

/** The tracker's selectApplicableFees (lib/types.ts): the contra's fees that apply to a transfer. */
export function selectApplicableFees(all: FeeRow[], accountType: string | null | undefined, transferType: string | null | undefined, direction?: string | null) {
  if (transferType?.trim().toLowerCase() === "residual credit") return { fees: [] as FeeRow[], total: 0, hasUnknownAmount: false };
  const account = accountType?.toLowerCase() ?? "";
  const acctCat = !accountType ? "ANY" : account.includes("ira") ? "IRA"
    : ["individual", "joint", "trust", "corporate"].includes(account) ? "BROKERAGE" : "ANY";
  const transfer = transferType?.toLowerCase();
  const transferCat = transfer === "full" ? "FULL" : transfer === "partial" ? "PARTIAL" : "ANY";
  const dir = direction?.toLowerCase();
  const directionCat = dir === "in" ? "IN" : dir === "out" ? "OUT" : "ANY";
  const fees = all.filter((f) => {
    const acctOk = f.accountType === "ANY" || f.accountType === acctCat;
    const transferOk = f.transferType === "ANY" || transferCat === "ANY" || f.transferType === transferCat;
    const feeDir = f.direction ?? "ANY";
    const directionOk = feeDir === "ANY" || directionCat === "ANY" || (feeDir === "OUT" && directionCat === "IN") || (feeDir === "IN" && directionCat === "OUT");
    return acctOk && transferOk && directionOk;
  });
  return { fees, total: fees.reduce((sum, f) => sum + (f.amount ?? 0), 0), hasUnknownAmount: fees.some((f) => f.amount == null) };
}

function planFee(t: PlannedTransfer, today: string): FeePlan {
  if (t.workflow === "RESIDUAL") return {};
  if (t.workflow === "DRS") return { feeCharged: "No" };
  let fee: { feeCharged: string; feeAmount: string; feeMemo: string };
  if (t.direction === "Out") {
    fee = { feeCharged: "Yes", feeAmount: "$75.00", feeMemo: "Apex outgoing transfer: $75.00" };
  } else {
    // The delivering firm's fee is only known once the transfer completes.
    if (!t.completionDay) return {};
    const rules = selectApplicableFees(
      t.firm.fees.map((f) => ({ ...f, accountType: f.accountType ?? "ANY", transferType: f.transferType ?? "ANY", direction: f.direction ?? "ANY" })),
      TRACKER_ACCOUNT_TYPE[t.account.type],
      t.type,
      t.direction,
    );
    if (rules.fees.length === 0 || (rules.total === 0 && !rules.hasUnknownAmount)) return { feeCharged: "No" };
    fee = {
      feeCharged: "Yes",
      feeAmount: money(rules.total),
      feeMemo: rules.fees.map((f) => `${f.feeType}: ${f.amount != null ? money(f.amount) : f.amountText ?? "?"}`).join(" + "),
    };
  }
  if (t.feeStage === "none" || t.feeStage === "unsubmitted" || !t.completionDay) return fee;
  const submitted = addBusinessDays(t.completionDay, seededInt(`${t.id}:feesub`, 1, 3));
  const completed = addBusinessDays(submitted, seededInt(`${t.id}:feedone`, 2, 6));
  return {
    ...fee,
    feeRequestSubmitted: submitted,
    feeRequestCompleted: t.feeStage === "completed" && completed < today ? completed : null,
  };
}

/** The last day of the month before `day`'s month: the statement period a request is usually made on. */
export function previousMonthEnd(day: string): string {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
}

function deliveringAccountNumber(t: PlannedTransfer, universe: Universe): string {
  const suffix = t.storyId
    ? universe.stories.statements.find((s) => s.id === universe.stories.transfers.find((x) => x.id === t.storyId)?.statement)?.accounts?.[0]?.suffix
    : undefined;
  const digits = String(seededInt(`${t.account.id}:${t.firm.prefix}:acct`, 1000, 9999));
  return `${t.firm.prefix}-${digits}${suffix ?? String(seededInt(`${t.id}:tail`, 1000, 9999))}`;
}

export interface DemoPlan {
  today: string;
  firms: DemoFirm[];
  transfers: PlannedTransfer[];
}

/** Every transfer the demo starts the day with, relative to `now`: the tracker demo's planDemoTransfers. */
export function planDemoTransfers(universe: Universe, now: Date): DemoPlan {
  const today = businessDayOnOrBefore(firmToday(now));
  const firms = demoFirms(universe);
  const firmsById = new Map(firms.filter((f) => f.universeId).map((f) => [f.universeId!, f]));
  const firmsByName = new Map(firms.map((f) => [f.name, f]));
  const history = historicalTransfers(universe, firms, today);
  const transfers = [...storyTransfers(universe, firmsById, today), ...history, ...residualTransfers(history, today), ...openTransfers(universe, firmsByName, today)];
  // Two of Edward Jones's recent completed transfers were logged against the duplicate card.
  const ids = new Set(transfers.map((t) => t.id));
  history
    .filter((t) => t.firm.name === "Edward Jones" && t.status === "Completed" && t.direction === "In" && !t.residualMonitoring && !ids.has(`${t.id}-r`))
    .slice(0, 2)
    .forEach((t) => { t.firm = firmsByName.get(DUPLICATE_FIRM)!; });
  assignNumbers(transfers);
  for (const t of transfers) {
    t.statementAccountNumber = t.workflow === "RESIDUAL" || t.direction === "Out" ? null : deliveringAccountNumber(t, universe);
    if (t.assets.length > 0) t.statement ??= { periodEnd: previousMonthEnd(t.requestDay), stale: false };
    t.fee = planFee(t, today);
  }
  // Fee-credit requests are numbered by the fee store in the order they were submitted.
  const submitted = transfers
    .filter((t) => t.fee?.feeRequestSubmitted)
    .sort((a, b) => String(a.fee!.feeRequestSubmitted).localeCompare(String(b.fee!.feeRequestSubmitted)) || a.id.localeCompare(b.id));
  submitted.forEach((t, index) => {
    t.fee!.feeCreditRequestId = String(1001 + index);
    t.fee!.feeApexTicket = `APX-TKT-${1301 + index}`;
  });
  return { today, firms, transfers };
}
