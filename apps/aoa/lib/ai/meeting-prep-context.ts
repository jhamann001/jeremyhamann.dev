// AI meeting prep — the PURE context assembler (blueprint ADR-8: "context
// assembly is the product"; the model is only a formatter).
//
// Deliberately PURE: no `server-only`, no Prisma, no clock, no imports from
// lib/data/* that pull a DB client. It takes an already-fetched
// `MeetingPrepSources` (gathered RLS-scoped by lib/data/meeting-prep.ts) and
// returns the context blob plus the observability counts the audit row records.
// Node-testable without a database — the lib/data/acat-status-catalog.ts idiom.
//
// WHAT IS DELIBERATELY *NOT* A SOURCE (blueprint §2, the most important negative
// finding): `lib/data/portrait.ts` (clientPortraitDetail) and
// `lib/data/client-reminders.ts` (clientReminders) are HYBRID MOCK — their
// feed/risk/riskFlag/instructions/portrait/taxBudget/prep and decisions/nudges
// fields come from `lib/mock/*` fixtures. Feeding fixtures into a prompt whose
// first line is "CONTEXT (the only facts you may rely on)" would launder invented
// risk profiles and tax budgets into a brief an advisor carries into a real
// client meeting. Their REAL parts (identity, deals, Apex accounts, AUM) are
// already covered here by blocks 3-5 via the same underlying readers. NEVER add
// them to MeetingPrepSources.
//
// NO-LOG: nothing in this module logs. The assembled text carries dense client
// PII (names, balances, mail, notes) and never reaches a log line.

// --- caps (all enforced below, all unit-tested) ------------------------------

/**
 * Global ceiling on the assembled blob (~6k tokens). Not a model limit — a
 * QUALITY and COST limit: long contexts degrade recall in the middle, and a
 * 500-word brief does not need the whole email archive.
 *
 * With the item + field caps below it is a BACKSTOP, not the usual binding
 * constraint: a maximally-full context lands well under it. It exists so that
 * raising a cap (or adding the slice-2 LAST MEETING NOTES block) can never
 * silently blow the context up. `assembleMeetingPrepContext` takes the budget as
 * an optional argument so the eviction path is directly unit-testable.
 */
export const CONTEXT_CHAR_BUDGET = 24_000;

export const ACCOUNT_ITEM_CAP = 12;
export const DEAL_ITEM_CAP = 5;
export const TRANSFER_ITEM_CAP = 5;
export const TASK_ITEM_CAP = 10;
export const ACTIVITY_ITEM_CAP = 8;
export const EMAIL_ITEM_CAP = 8;

export const TASK_DESCRIPTION_CHAR_CAP = 300;
export const ACTIVITY_NOTE_CHAR_CAP = 400;
export const EMAIL_BODY_CHAR_CAP = 400;

/** Emitted for a block with nothing in it. LOAD-BEARING: an empty block is
 *  EMITTED, never omitted, so the model learns the absence is a FACT. Under the
 *  engine's [PLACEHOLDER] guardrail that yields "no recent email contact —
 *  confirm whether outreach happened outside CRM" instead of an invented
 *  exchange. */
export const NONE_ON_FILE = "(none on file)";

/** Replaces a whole block's body when the global budget binds. */
export const OMITTED_FOR_BUDGET = "(omitted — context budget)";

/** Emitted when the appointment carries no client_sf_id (the common case — the
 *  mirror.appointment match is best-effort and "often null"). */
export const NO_LINKED_CLIENT =
  "(no linked client record — every client fact below is unavailable)";

/** The TASK half of the prompt. A FIXED string: no client data is interpolated
 *  into the instruction, only into the CONTEXT half. */
export const MEETING_PREP_INSTRUCTION =
  "Write the prep brief for this meeting. Lead with what changed since the last " +
  "contact and what the advisor must not walk in without knowing. Under 'Talking " +
  "points' give 3-5 concrete points grounded in the context. Under 'Questions to " +
  "ask', list what the context does not answer, as bracketed [PLACEHOLDER]s where " +
  "a specific fact is missing.";

// --- input shapes -------------------------------------------------------------
// Narrow, self-describing shapes rather than the wide reader row types: the
// fetcher projects into these, which keeps this module free of any import that
// could drag Prisma into a node test.

export type PrepMeeting = {
  clientName: string | null;
  advisorName: string | null;
  meetingType: string | null;
  /** Human "when" (already formatted by the caller — this module has no clock). */
  when: string;
};

export type PrepClient = {
  name: string | null;
  householdName: string | null;
  householdStatus: string | null;
  householdStage: string | null;
  leadAdvisorEmail: string | null;
};

export type PrepAccount = {
  accountType: string | null;
  /** FULL Apex account number — masked to last-4 here, never emitted whole. */
  apexAccountNumber: string | null;
  accountStatus: string | null;
  isManaged: boolean;
  accountAum: number | null;
  asOf: Date | null;
};

export type PrepDeal = {
  name: string | null;
  stage: string | null;
  amount: number | null;
  closeDate: Date | null;
  fundingType: string | null;
  transferringFirm: string | null;
  ownerName: string | null;
};

export type PrepTransfer = {
  stage: string | null;
  daysInStage: number | null;
  value: number | null;
  fundingType: string | null;
  nextStep: string | null;
  accountsOpenedAtApex: boolean;
  fundingPlanComplete: boolean;
  fundingInitiated: boolean;
  cashInFlight: boolean;
  acatLinked: boolean;
  /** Slack closeout progress as done/total, or null when no checklist exists. */
  closeoutDone: number | null;
  closeoutTotal: number | null;
};

export type PrepTask = {
  subject: string | null;
  status: string | null;
  priority: string | null;
  description: string | null;
};

export type PrepActivity = {
  at: Date | null;
  subject: string | null;
  ownerName: string | null;
  note: string | null;
};

export type PrepEmail = {
  at: Date | null;
  subject: string | null;
  body: string | null;
};

/**
 * Everything the assembler is allowed to see. Items in every list arrive
 * MOST-RECENT-FIRST (the readers already `ORDER BY … DESC NULLS LAST`), so an
 * item cap drops the OLDEST.
 */
export type MeetingPrepSources = {
  meeting: PrepMeeting;
  /** null when the appointment has no resolvable client_sf_id (blocks 3-9 empty). */
  client: PrepClient | null;
  aumTotal: number | null;
  accounts: PrepAccount[];
  deals: PrepDeal[];
  transfers: PrepTransfer[];
  tasks: PrepTask[];
  activity: PrepActivity[];
  emails: PrepEmail[];
};

export type MeetingPrepSourceCounts = {
  accounts: number;
  deals: number;
  transfers: number;
  tasks: number;
  activity: number;
  emails: number;
};

export type AssembledContext = {
  text: string;
  chars: number;
  /** True when an item cap, a field cap or the global budget dropped anything. */
  truncated: boolean;
  /** Counts of what was ACTUALLY RENDERED (post-cap, post-budget) — these are
   *  the numbers that go into the audit detail. */
  sources: MeetingPrepSourceCounts;
};

// --- small pure helpers --------------------------------------------------------

/** Mask an account number to its last 4 (`••1234`). The advisor does not need
 *  the full number to prep, and the brief is PERSISTED — so it is masked before
 *  it ever reaches the model, and therefore masked in storage too. Mirrors the
 *  house `accountLast4` convention (lib/audit.ts). Null/empty → `••••`. */
export function maskAccount(n: string | null | undefined): string {
  const s = (n ?? "").trim();
  if (s === "") return "••••";
  return `••${s.slice(-4)}`;
}

/** Cut a free-text field at `cap` and append `…`. Returns { text, cut }. */
export function capField(
  v: string | null | undefined,
  cap: number,
): { text: string; cut: boolean } {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= cap) return { text: s, cut: false };
  return { text: `${s.slice(0, cap)}…`, cut: true };
}

const usd = (n: number | null | undefined): string =>
  n == null
    ? "unknown"
    : `$${Math.round(n).toLocaleString("en-US")}`;

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "short",
  day: "numeric",
});

/** Clock-free date rendering (formats a given instant; never reads `now`). */
const day = (d: Date | null | undefined): string =>
  d == null ? "date unknown" : DATE_FMT.format(d);

const yn = (b: boolean): string => (b ? "yes" : "no");

const dash = (v: string | null | undefined, fallback = "unknown"): string => {
  const s = (v ?? "").trim();
  return s === "" ? fallback : s;
};

/** Apply an item cap to a most-recent-first list; the tail (oldest) is dropped. */
function capItems<T>(items: T[], cap: number): { kept: T[]; dropped: number } {
  if (items.length <= cap) return { kept: items, dropped: 0 };
  return { kept: items.slice(0, cap), dropped: items.length - cap };
}

type Block = {
  header: string;
  lines: string[];
  /** Blocks 1 and 3 are structural — the global budget may never drop them. */
  droppable: boolean;
  /** Which source count this block feeds (null for MEETING / CLIENT). */
  countKey: keyof MeetingPrepSourceCounts | null;
  /** Items actually rendered in this block. */
  count: number;
};

function render(block: Block): string {
  const body = block.lines.length > 0 ? block.lines.join("\n") : NONE_ON_FILE;
  return `=== ${block.header} ===\n${body}`;
}

// --- the assembler --------------------------------------------------------------

/**
 * Assemble the context blob for one meeting.
 *
 * Ordering is HIGHEST-VALUE-FIRST so that when the budget binds, what is dropped
 * is what mattered least. Truncation rules, in order:
 *   1. per-block item caps + per-field char caps (applied first);
 *   2. items are most-recent-first, so a cap drops the OLDEST;
 *   3. field truncation cuts and appends `…`; item truncation drops WHOLE items
 *      and appends `(+N older not shown)` — never half a record, because a
 *      half-record is exactly what a model hallucinates around;
 *   4. if the text still exceeds CONTEXT_CHAR_BUDGET, whole blocks are dropped
 *      BOTTOM-UP (emails first) and replaced with `(omitted — context budget)`;
 *      MEETING and CLIENT & HOUSEHOLD can never be dropped;
 *   5. an empty block is EMITTED as `(none on file)`, never omitted.
 *
 * Never throws: an appointment with no linked client yields block 1 plus the
 * "no linked client record" note and six `(none on file)` blocks, which the
 * engine's [PLACEHOLDER] guardrail turns into an honest, thin brief.
 */
export function assembleMeetingPrepContext(
  sources: MeetingPrepSources,
  budget: number = CONTEXT_CHAR_BUDGET,
): AssembledContext {
  let truncated = false;
  const note = (dropped: number): string[] =>
    dropped > 0 ? [`(+${dropped} older not shown)`] : [];

  // --- Block 1: MEETING (never dropped) --------------------------------------
  const m = sources.meeting;
  const meetingBlock: Block = {
    header: "MEETING",
    lines: [
      `When: ${dash(m.when, "unknown")}`,
      `Type: ${dash(m.meetingType, "Appointment")}`,
      `Client: ${dash(m.clientName, "unknown")}`,
      `Advisor: ${dash(m.advisorName, "unassigned")}`,
    ],
    droppable: false,
    countKey: null,
    count: 0,
  };

  // Block 2 is RESERVED for slice 2 (LAST MEETING NOTES — Notewell). It slots in
  // here, between MEETING and CLIENT & HOUSEHOLD, with no other change.

  const linked = sources.client !== null;

  // --- Block 3: CLIENT & HOUSEHOLD (never dropped) ---------------------------
  const c = sources.client;
  const clientBlock: Block = {
    header: "CLIENT & HOUSEHOLD",
    lines: c
      ? [
          `Client: ${dash(c.name)}`,
          `Household: ${dash(c.householdName, "none on file")}`,
          `Household status: ${dash(c.householdStatus)} · stage: ${dash(c.householdStage)}`,
          `Lead advisor: ${dash(c.leadAdvisorEmail, "unassigned")}`,
        ]
      : [],
    droppable: false,
    countKey: null,
    count: 0,
  };

  // --- Block 4: ACCOUNTS & AUM ------------------------------------------------
  const acc = capItems(linked ? sources.accounts : [], ACCOUNT_ITEM_CAP);
  if (acc.dropped > 0) truncated = true;
  const accountLines =
    acc.kept.length > 0 || sources.aumTotal != null
      ? [
          `Total Apex AUM: ${usd(sources.aumTotal)}`,
          ...acc.kept.map(
            (a) =>
              `- ${dash(a.accountType, "account")} ${maskAccount(a.apexAccountNumber)} · ` +
              `${dash(a.accountStatus, "status unknown")} · ${a.isManaged ? "managed" : "unmanaged"} · ` +
              `${usd(a.accountAum)} (as of ${day(a.asOf)})`,
          ),
          ...note(acc.dropped),
        ]
      : [];
  const accountsBlock: Block = {
    header: "ACCOUNTS & AUM",
    lines: accountLines,
    droppable: true,
    countKey: "accounts",
    count: acc.kept.length,
  };

  // --- Block 5: OPEN DEALS (WON/LOST filtered out by the fetcher) -------------
  const dl = capItems(linked ? sources.deals : [], DEAL_ITEM_CAP);
  if (dl.dropped > 0) truncated = true;
  const dealsBlock: Block = {
    header: "OPEN DEALS",
    lines: [
      ...dl.kept.map(
        (d) =>
          `- ${dash(d.name, "unnamed deal")} · ${dash(d.stage)} · ${usd(d.amount)} · ` +
          `expected close ${day(d.closeDate)} · funding ${dash(d.fundingType, "n/a")} · ` +
          `from ${dash(d.transferringFirm, "n/a")} · owner ${dash(d.ownerName, "unassigned")}`,
      ),
      ...note(dl.dropped),
    ],
    droppable: true,
    countKey: "deals",
    count: dl.kept.length,
  };

  // --- Block 6: MONEY IN FLIGHT (non-FUNDED transfers) ------------------------
  const tr = capItems(linked ? sources.transfers : [], TRANSFER_ITEM_CAP);
  if (tr.dropped > 0) truncated = true;
  const transfersBlock: Block = {
    header: "MONEY IN FLIGHT",
    lines: [
      ...tr.kept.map((t) => {
        const closeout =
          t.closeoutTotal == null
            ? "no closeout checklist"
            : `closeout ${t.closeoutDone ?? 0}/${t.closeoutTotal}`;
        return (
          `- ${dash(t.stage)} for ${t.daysInStage ?? "?"}d · ${usd(t.value)} · ` +
          `funding ${dash(t.fundingType, "n/a")} · next step: ${dash(t.nextStep, "none recorded")} · ` +
          `accounts open ${yn(t.accountsOpenedAtApex)}, plan complete ${yn(t.fundingPlanComplete)}, ` +
          `funding initiated ${yn(t.fundingInitiated)}, cash in flight ${yn(t.cashInFlight)} · ` +
          `ACAT linked ${yn(t.acatLinked)} · ${closeout}`
        );
      }),
      ...note(tr.dropped),
    ],
    droppable: true,
    countKey: "transfers",
    count: tr.kept.length,
  };

  // --- Block 7: OPEN ITEMS (household tasks, non-completed) -------------------
  const tk = capItems(linked ? sources.tasks : [], TASK_ITEM_CAP);
  if (tk.dropped > 0) truncated = true;
  const taskLines = tk.kept.map((t) => {
    const d = capField(t.description, TASK_DESCRIPTION_CHAR_CAP);
    if (d.cut) truncated = true;
    return (
      `- ${dash(t.subject, "untitled task")} · ${dash(t.status)} · priority ${dash(t.priority, "n/a")}` +
      (d.text ? ` · ${d.text}` : "")
    );
  });
  const tasksBlock: Block = {
    header: "OPEN ITEMS",
    lines: [...taskLines, ...note(tk.dropped)],
    droppable: true,
    countKey: "tasks",
    count: tk.kept.length,
  };

  // --- Block 8: RECENT CALLS & NOTES -----------------------------------------
  const ac = capItems(linked ? sources.activity : [], ACTIVITY_ITEM_CAP);
  if (ac.dropped > 0) truncated = true;
  const activityLines = ac.kept.map((a) => {
    const n = capField(a.note, ACTIVITY_NOTE_CHAR_CAP);
    if (n.cut) truncated = true;
    return (
      `- ${day(a.at)} · ${dash(a.subject, "no subject")} · ${dash(a.ownerName, "unknown owner")}` +
      (n.text ? ` · ${n.text}` : "")
    );
  });
  const activityBlock: Block = {
    header: "RECENT CALLS & NOTES",
    lines: [...activityLines, ...note(ac.dropped)],
    droppable: true,
    countKey: "activity",
    count: ac.kept.length,
  };

  // --- Block 9: RECENT EMAILS -------------------------------------------------
  const em = capItems(linked ? sources.emails : [], EMAIL_ITEM_CAP);
  if (em.dropped > 0) truncated = true;
  const emailLines = em.kept.map((e) => {
    const b = capField(e.body, EMAIL_BODY_CHAR_CAP);
    if (b.cut) truncated = true;
    return `- ${day(e.at)} · ${dash(e.subject, "no subject")}` + (b.text ? ` · ${b.text}` : "");
  });
  const emailsBlock: Block = {
    header: "RECENT EMAILS",
    lines: [...emailLines, ...note(em.dropped)],
    droppable: true,
    countKey: "emails",
    count: em.kept.length,
  };

  const blocks: Block[] = [
    meetingBlock,
    clientBlock,
    accountsBlock,
    dealsBlock,
    transfersBlock,
    tasksBlock,
    activityBlock,
    emailsBlock,
  ];

  // Emitted (post-budget) counts start from what the caps left; a block dropped
  // for budget below zeroes its own count, so `sources` always describes what
  // the model actually saw.
  const counts: MeetingPrepSourceCounts = {
    accounts: accountsBlock.count,
    deals: dealsBlock.count,
    transfers: transfersBlock.count,
    tasks: tasksBlock.count,
    activity: activityBlock.count,
    emails: emailsBlock.count,
  };

  const prefix = linked ? "" : `${NO_LINKED_CLIENT}\n\n`;
  const dropped = new Set<Block>();
  const compose = (): string =>
    prefix +
    blocks
      .map((b) =>
        dropped.has(b) ? `=== ${b.header} ===\n${OMITTED_FOR_BUDGET}` : render(b),
      )
      .join("\n\n");

  let text = compose();
  // Rule 4: over budget → drop whole blocks BOTTOM-UP (emails first), never the
  // two structural blocks.
  for (let i = blocks.length - 1; i >= 0 && text.length > budget; i--) {
    const b = blocks[i];
    if (!b.droppable) continue;
    dropped.add(b);
    truncated = true;
    if (b.countKey) counts[b.countKey] = 0;
    text = compose();
  }

  return { text, chars: text.length, truncated, sources: counts };
}
