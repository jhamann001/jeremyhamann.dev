import type {
  ClientAccounts,
  MeetingPrep,
  PortraitEmail,
  PortraitFeedItem,
  RiskProfile,
} from "@/lib/data/types";

// Deterministic mock fixtures for the Client Portrait (TDD §3/§7, ADR-2/ADR-4).
// Keyed by REAL seeded client `sf_id` (prisma/seed.ts CLIENTS, e.g. "C-1")
// where per-client; a `default` entry backs any client without a bespoke
// fixture so the seam always returns a typed shape. Wired to
// real sources in Phase D (mirror.communication / activity / risk_profile /
// client_directive / client_summary / deal); the seam signatures stay unchanged.

export const emailsByClient: Record<string, PortraitEmail[]> = {
  default: [
    {
      from: "Client",
      time: "9:14 AM",
      subject: "Question on quarterly statement",
      preview: "Wanted to double-check the fees line on the latest…",
      unread: true,
    },
    {
      from: "Custodian",
      time: "Yesterday",
      subject: "Transfer confirmation",
      preview: "Your recent ACAT transfer has completed and posted…",
      unread: false,
    },
  ],
  "C-1": [
    {
      from: "Sam Stone",
      time: "8:02 AM",
      subject: "RMD timing for this year",
      preview: "Can we schedule the distribution before year-end…",
      unread: true,
    },
    {
      from: "Sam Stone",
      time: "Mon",
      subject: "Re: Quarterly review agenda",
      preview: "Looks good — I'd like to add a question about the trust…",
      unread: false,
    },
  ],
};

export const feedByClient: Record<string, PortraitFeedItem[]> = {
  default: [
    { kind: "note", time: "10:20 AM", title: "Call summary", desc: "Discussed rebalancing and cash needs." },
    { kind: "task", time: "Yesterday", title: "Sent proposal", desc: "Advice plan v2 delivered for review." },
    { kind: "event", time: "2 days ago", title: "Account funded", desc: "Initial transfer posted to brokerage." },
  ],
  "C-1": [
    { kind: "note", time: "8:30 AM", title: "Trust review note", desc: "Confirmed successor trustee details." },
    { kind: "event", time: "Yesterday", title: "Deposit received", desc: "$250,000 wire posted to the joint account." },
    { kind: "task", time: "3 days ago", title: "RMD reminder", desc: "Scheduled distribution paperwork." },
  ],
};

export const riskByClient: Record<string, RiskProfile> = {
  default: { score: 14, tolerance: "Moderate", capacity: "Above average", change: "No change" },
  "C-1": { score: 11, tolerance: "Conservative", capacity: "High", change: "-2 vs last review" },
};

export const instructionsByClient: Record<string, { label: string; value: string }[]> = {
  default: [
    { label: "Objective", value: "Balanced growth with income" },
    { label: "Restrictions", value: "No tobacco holdings" },
    { label: "Rebalance band", value: "±5% from target" },
    { label: "Cash reserve", value: "6 months of expenses" },
  ],
  "C-1": [
    { label: "Objective", value: "Capital preservation" },
    { label: "Restrictions", value: "No individual equities" },
    { label: "Rebalance band", value: "±3% from target" },
    { label: "Cash reserve", value: "12 months of expenses" },
  ],
};

export const portraitByClient: Record<string, Record<string, string>> = {
  default: {
    Family: "Married, two adult children",
    Goals: "Retire at 62; fund grandchildren's education",
    Communication: "Prefers email; quarterly calls",
    Behavior: "Long-term, low reactivity to volatility",
    Worry: "Outliving assets",
    Themes: "Legacy, tax efficiency",
  },
  "C-1": {
    Family: "Widowed; family trust for two children",
    Goals: "Preserve estate; smooth RMD distributions",
    Communication: "Prefers phone; monthly check-ins",
    Behavior: "Cautious; values certainty",
    Worry: "Estate tax exposure",
    Themes: "Trust administration, gifting",
  },
};

// ---------------------------------------------------------------------------
// P1 parity fixtures (ticket) — deferred Core Financial account details,
// risk flag pill, and Meeting Prep. ALL INVENTED data, keyed to the seeded
// clients (C-1…C-6) with a `default` fallback, exactly like the fixtures
// above. Wired to Apex/Plaid/calendar reads in Phase D behind the same seams.
// ---------------------------------------------------------------------------

// Risk profile header flag (mockup `#n2riskflag`). Null = no pill.
export const riskFlagByClient: Record<string, string | null> = {
  default: null,
  "C-1": "▲ flagged change",
};

export const accountsByClient: Record<string, ClientAccounts> = {
  default: {
    apex: [{ type: "Individual Brokerage", num: "••••1000", status: "Active", value: 480000 }],
    ext: [],
    bene: [],
    plaidLinked: false,
  },
  // Sam Stone · Stone Family Trust (HH-1001) — full stack, Plaid linked.
  "C-1": {
    apex: [
      { type: "Trust Brokerage", num: "••••2100", status: "Active", value: 1620000 },
      { type: "Traditional IRA (Rollover)", num: "••••2922", status: "Active", value: 610000 },
      { type: "Roth IRA", num: "••••5725", status: "Active", value: 220000 },
    ],
    ext: [
      { inst: "First Federal", type: "Checking", num: "••••1835", balance: 84000 },
      { inst: "Vanguard", type: "529 — held away", num: "••••1690", balance: 132000 },
    ],
    bene: [
      { name: "Jo Stone", rel: "Spouse", pct: 100, dob: "03/12/1958", acct: "Traditional IRA (Rollover)", num: "••••2922" },
      { name: "Casey Stone", rel: "Child", pct: 50, dob: "06/04/1988", acct: "Roth IRA", num: "••••5725" },
      { name: "Drew Stone", rel: "Child", pct: 50, dob: "09/22/1991", acct: "Roth IRA", num: "••••5725" },
    ],
    plaidLinked: true,
  },
  // Jo Stone — deliberately sparse: exercises every empty state.
  "C-2": { apex: [], ext: [], bene: [], plaidLinked: false, prospect: true },
  // Minh Nguyen (HH-1002) — Funding status pill + Plaid not linked.
  "C-3": {
    apex: [
      { type: "Individual Brokerage", num: "••••2829", status: "Funding", value: 730000 },
      { type: "Roth IRA", num: "••••2965", status: "Active", value: 450000 },
    ],
    ext: [],
    bene: [{ name: "An Nguyen", rel: "Spouse", pct: 100, dob: "08/15/1984", acct: "Roth IRA", num: "••••2965" }],
    plaidLinked: false,
  },
  // Ada Okafor (HH-1003) — funding, one external account.
  "C-4": {
    apex: [
      { type: "SEP IRA", num: "••••5254", status: "Active", value: 640000 },
      { type: "Individual Brokerage", num: "••••6186", status: "Funding", value: 235000 },
    ],
    ext: [{ inst: "Mercury", type: "Business Checking", num: "••••4004", balance: 96000 }],
    bene: [{ name: "Chidi Okafor", rel: "Spouse", pct: 100, dob: "02/09/1980", acct: "SEP IRA", num: "••••5254" }],
    plaidLinked: true,
  },
  // Neil Walker (HH-2001) — largest book, multiple bene groups.
  "C-5": {
    apex: [
      { type: "Joint Brokerage (TOD)", num: "••••8440", status: "Active", value: 2100000 },
      { type: "Traditional IRA", num: "••••1564", status: "Active", value: 890000 },
      { type: "Roth IRA", num: "••••3637", status: "Active", value: 330000 },
    ],
    ext: [
      { inst: "Chase", type: "Checking", num: "••••0606", balance: 152000 },
      { inst: "Fidelity", type: "401(k) — held away", num: "••••4713", balance: 415000 },
    ],
    bene: [
      { name: "Sky Walker", rel: "Spouse", pct: 60, dob: "05/18/1979", acct: "Traditional IRA", num: "••••1564" },
      { name: "Abe Walker", rel: "Child", pct: 40, dob: "11/02/2006", acct: "Traditional IRA", num: "••••1564" },
      { name: "Sky Walker", rel: "Spouse", pct: 100, dob: "05/18/1979", acct: "Roth IRA", num: "••••3637" },
    ],
    plaidLinked: true,
  },
  // Asha Patel (HH-2002) — active, Plaid not linked.
  "C-6": {
    apex: [
      { type: "Individual Brokerage", num: "••••4595", status: "Active", value: 1210000 },
      { type: "Traditional IRA", num: "••••3847", status: "Active", value: 330000 },
    ],
    ext: [],
    bene: [{ name: "Ravi Patel", rel: "Spouse", pct: 100, dob: "07/27/1982", acct: "Traditional IRA", num: "••••3847" }],
    plaidLinked: false,
  },
};

// Mockup PREP_DATA analogue — one prep record per seeded client (C-2 has none,
// exercising the empty prep card + placeholder panel). Advisors/AUM match the
// seed (prisma/seed.ts HOUSEHOLDS/ADVISORS); every narrative string is invented.
export const prepByClient: Record<string, MeetingPrep | null> = {
  default: null,
  "C-1": {
    advisor: "Avery Stone",
    aum: "$2.45M",
    tenure: "6 yrs",
    riskProfile: "Conservative (11/25)",
    lastMeeting: "Jun 12, 2026 — Quarterly review",
    recentSignals: [
      "Emailed about RMD timing for this year",
      "Large deposit received — $250K wire to the joint account",
    ],
    openItems: [
      "Schedule the 2026 RMD distribution",
      "Confirm the 2026 tax budget",
      "Re-confirm trust beneficiaries",
    ],
    talkingPoints:
      "Walk through the RMD amount and timing\nReview the trust distribution plan with the successor trustee\nConfirm the realized-gains budget before any harvesting",
    notes: "Values certainty — lead with the plan, not the options. Phone over email.",
  },
  "C-2": null,
  "C-3": {
    advisor: "Avery Stone",
    aum: "$1.18M",
    tenure: "2 yrs",
    riskProfile: "Moderate (14/25)",
    lastMeeting: "May 28, 2026 — Financial plan draft",
    recentSignals: [
      "Risk questionnaire completed",
      "Brokerage transfer still in Funding status",
    ],
    openItems: [
      "Finalize the financial plan",
      "Confirm funding has fully landed",
      "Link external accounts via Plaid",
    ],
    talkingPoints:
      "Present the final plan and target allocation\nConfirm the transfer landed and the account is live\nWalk through Plaid linking for held-away balances",
    notes: "",
  },
  "C-4": {
    advisor: "Avery Stone",
    aum: "$875K",
    tenure: "New — funding",
    riskProfile: "Growth (18/25)",
    lastMeeting: "Jun 20, 2026 — Onboarding",
    recentSignals: [
      "Proposal open 8 days — awaiting client",
      "Business checking linked via Plaid",
    ],
    openItems: [
      "Countersign the advisory agreement",
      "Set the 2026 realized-gains budget",
      "Complete beneficiary designations on the brokerage",
    ],
    talkingPoints:
      "Confirm the funding timeline for the brokerage\nSet the 2026 tax budget — nothing on file yet\nSEP IRA contribution plan before the filing deadline",
    notes: "Prefers direct, numbers-first meetings.",
  },
  "C-5": {
    advisor: "Gwen Kuhlman",
    aum: "$3.32M",
    tenure: "8 yrs",
    riskProfile: "Moderate growth (16/25)",
    lastMeeting: "Jun 3, 2026 — Property sale planning",
    recentSignals: [
      "Realized gains now over the 2026 budget",
      "Asked about 529 rollover options",
    ],
    openItems: [
      "Rebalance — equity 4.1% over band",
      "Defer remaining property-sale gains to 2027",
      "Review 401(k) held-away allocation",
    ],
    talkingPoints:
      "Address the over-budget realized gains and the deferral plan\nRebalancing plan within the tax constraints\n529 rollover mechanics for Abe",
    notes: "Joint decisions — make sure Sky is on the invite.",
  },
  "C-6": {
    advisor: "Gwen Kuhlman",
    aum: "$1.54M",
    tenure: "3 yrs",
    riskProfile: "Moderate (13/25)",
    lastMeeting: "Apr 22, 2026 — Annual review",
    recentSignals: ["Opened the retirement illustration twice this week"],
    openItems: [
      "Set the 2026 tax budget",
      "Link external accounts via Plaid",
      "Schedule the mid-year check-in",
    ],
    talkingPoints:
      "Mid-year portfolio and plan check-in\nSet the realized-gains budget — none on file\nDiscuss the retirement date scenarios she has been exploring",
    notes: "",
  },
};
