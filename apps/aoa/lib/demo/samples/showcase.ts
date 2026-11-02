// The showcase clients: four people in three story households whose every Client Portrait section is filled, written by
// hand to agree with what the demo seed records about them (activity.ts calls, email and tasks; the universe's transfer,
// trade and help-desk stories; operations.ts fee requests and held-away accounts; own-accounts.ts and
// trade-requests-own.ts). Advisor, AUM, tenure and risk come from the same records when build.ts runs, so they can't
// drift. Every name and figure is invented. Pure.

import type { DualViewInsight } from "@/lib/mock/client-experiences";

/** A dated line: days before the seed's day, or the day an account was opened or first funded (its Initial Funding
 *  request in trade-requests-own.ts), which the seed dates relative to its own day. */
export interface ShowcaseMoment {
  daysAgo: number | { opened: string } | { funded: string };
  text: string;
  source: string;
}

export interface ShowcaseBeneficiary {
  /** A universe account id (acct-…) or an own account id (own-…). */
  account: string;
  name: string;
  rel: string;
  pct: number;
  dob: string;
}

export interface ShowcaseClient {
  person: string;
  portrait: Record<string, string>;
  beneficiaries: ShowcaseBeneficiary[];
  prep: {
    lastMeeting: { daysAgo: number; label: string };
    recentSignals: string[];
    openItems: string[];
    talkingPoints: string[];
    notes: string;
  };
  dualView: {
    label: string;
    description: string;
    meetingLabel: string;
    brief: string;
    realTime: ShowcaseMoment[];
    historical: ShowcaseMoment[];
    insights: DualViewInsight[];
  };
  taxBudget: { budget: number; realized: number; note: string; prior: number | null };
}

export const SHOWCASE: ShowcaseClient[] = [
  {
    person: "okafor-kofi",
    portrait: {
      Family: "Married to Ada; two adult children, Amara and Tobi",
      Goals: "Bring the Edward Jones accounts under one plan; retire around 62",
      Communication: "Email for updates; a call for decisions",
      Behavior: "Holds winners; reluctant to sell NVDA",
      Worry: "Taxes on the concentrated NVDA position",
      Themes: "Consolidation, concentrated stock, tax efficiency",
    },
    beneficiaries: [
      { account: "acct-004", name: "Amara Okafor", rel: "Child (TOD)", pct: 50, dob: "04/18/2001" },
      { account: "acct-004", name: "Tobi Okafor", rel: "Child (TOD)", pct: 50, dob: "09/02/2004" },
    ],
    prep: {
      lastMeeting: { daysAgo: 21, label: "Statement review call" },
      recentSignals: [
        "Asked by email when the Edward Jones accounts will show up",
        "Joint account in transfer: positions settling, the Bridge Builder fund sold first",
        "Rebalance request REQ-00001045 waiting in the trade desk's review",
      ],
      openItems: [
        "Release the rebalance into Growth 80/20 once the transfer settles",
        "Start paperwork for the Edward Jones Roth IRA and individual account",
        "Agree a plan for the NVDA position before the individual account moves",
      ],
      talkingPoints: [
        "Transfer timing: what has landed and what is still selling",
        "The rebalance into Meridian Growth 80/20 and when it runs",
        "NVDA: hold, trim or gift before the individual account moves",
        "Next transfers: Ada's Roth IRA and Kofi's individual account",
      ],
      notes: "Kofi asks about timing by email; Ada handles the paperwork. Invite both.",
    },
    dualView: {
      label: "Consolidating from Edward Jones",
      description: "A partial transfer in flight, a rebalance waiting on it, and two accounts still to move.",
      meetingLabel: "Transfer kickoff follow-up · sample agenda",
      brief:
        "The Edward Jones joint account is in transfer. Every position but the Bridge Builder fund arrives in kind; that fund is sold first and comes over as cash. REQ-00001045 rebalances into Meridian Growth 80/20 once it settles, so lead with timing, then agree what happens to the NVDA position in Kofi's Edward Jones individual account before it moves.",
      realTime: [
        { daysAgo: 0, text: "Rebalance request REQ-00001045 waiting in the trade desk's review", source: "Trade Request · in review" },
        { daysAgo: 3, text: "Ada told the transfer is pending settlement; Bridge Builder fund sells first", source: "CRM call log" },
        { daysAgo: 3, text: "Replied to Kofi's question on transfer timing", source: "Email" },
        { daysAgo: 4, text: "Edward Jones joint account moved to In transfer (CTL-10421)", source: "Transfer Tracker" },
        { daysAgo: 9, text: "Roth IRA beneficiary form sent to Ada; ticket HD-2481 open", source: "Help desk" },
      ],
      historical: [
        { daysAgo: 21, text: "September Edward Jones statement reviewed: three accounts to bring over", source: "CRM call log" },
        { daysAgo: { funded: "own-okafor-ada" }, text: "Ada's SEP IRA invested in Meridian Growth 80/20 (REQ-00000901)", source: "Trade Request" },
        { daysAgo: { opened: "own-okafor-ada" }, text: "Household's first account opened: Ada's SEP IRA", source: "Custodian account record" },
      ],
      insights: [
        { tone: "opportunity", title: "Rebalance the day it settles", body: "REQ-00001045 is waiting in review. Releasing it as soon as positions settle keeps the joint account off its model for the shortest time.", status: "Meeting priority", provenance: "Synthesized from REQ-00001045 + transfer CTL-10421" },
        { tone: "risk", title: "Concentrated NVDA position", body: "260 NVDA shares are about 90% of Kofi's Edward Jones individual account. The trade desk's exclusion stops the firm adding more; agree a plan before that account moves.", status: "Open item", provenance: "Synthesized from held-away holdings + client exclusion" },
        { tone: "context", title: "Ada runs the paperwork", body: "Ada took the transfer call and has the beneficiary form; Kofi follows up on timing by email. Copy both on the recap.", status: "Communication", provenance: "Synthesized from call log + email" },
        { tone: "healthy", title: "Partial transfer on schedule", body: "Four days in transfer is inside the usual window, and only the Bridge Builder fund needs selling at Edward Jones.", status: "On track", provenance: "Synthesized from the Transfer Tracker record" },
      ],
    },
    taxBudget: {
      budget: 25_000,
      realized: 0,
      note: "The rebalance after the Edward Jones transfer will realize gains. AAPL has a low basis and is excluded from selling; keep the rebalance under this budget.",
      prior: null,
    },
  },
  {
    person: "okafor-ada",
    portrait: {
      Family: "Married to Kofi; two adult children, Amara and Tobi",
      Goals: "Steady retirement saving from her consulting income",
      Communication: "Phone; prefers to handle forms herself",
      Behavior: "Detail-oriented; reads every form before signing",
      Worry: "Leaving the right beneficiaries on every account",
      Themes: "Self-employed retirement saving, beneficiary planning",
    },
    beneficiaries: [
      { account: "own-okafor-ada", name: "Kofi Okafor", rel: "Spouse", pct: 100, dob: "07/22/1971" },
    ],
    prep: {
      lastMeeting: { daysAgo: 3, label: "Transfer update call" },
      recentSignals: [
        "Roth IRA beneficiary form sent nine days ago, not yet signed",
        "Edward Jones Roth IRA linked through Plaid: $121,644, about 18% in cash",
        "SEP IRA on Meridian Growth 80/20 since its first contribution",
      ],
      openItems: [
        "Signed Roth IRA beneficiary form (HD-2481)",
        "Plan the Roth IRA's move after the joint account settles",
        "This year's SEP IRA contribution",
      ],
      talkingPoints: [
        "Roth IRA beneficiaries: Amara and Tobi, 50/50",
        "Moving the Roth IRA once the joint account settles",
        "SEP IRA contribution for this tax year",
      ],
      notes: "Reads every form closely; walk through the beneficiary form line by line.",
    },
    dualView: {
      label: "Beneficiaries before the next transfer",
      description: "A three-year SEP IRA client with a Roth IRA still at Edward Jones and a form to sign.",
      meetingLabel: "Beneficiary and transfer check-in · sample agenda",
      brief:
        "Ada's SEP IRA has been with the firm for three years on Meridian Growth 80/20. Her Edward Jones Roth IRA moves after the joint account settles, and the beneficiary form for it is still unsigned (HD-2481). Get the form signed so the new designation is in place when the Roth IRA arrives.",
      realTime: [
        { daysAgo: 1, text: "Edward Jones Roth IRA refreshed through Plaid: $121,644", source: "Plaid held-away account" },
        { daysAgo: 3, text: "Took the call on the Edward Jones transfer's status", source: "CRM call log" },
        { daysAgo: 9, text: "Beneficiary designation form sent for the Roth IRA", source: "Email" },
        { daysAgo: 9, text: "Help desk ticket HD-2481 opened: update beneficiary on Roth IRA", source: "Help desk" },
      ],
      historical: [
        { daysAgo: 21, text: "September statement reviewed: the Roth IRA moves after the joint account", source: "CRM call log" },
        { daysAgo: { funded: "own-okafor-ada" }, text: "SEP IRA invested in Meridian Growth 80/20 (REQ-00000901)", source: "Trade Request" },
        { daysAgo: { opened: "own-okafor-ada" }, text: "Opened a SEP IRA for her consulting income", source: "Custodian account record" },
      ],
      insights: [
        { tone: "opportunity", title: "Move the Roth IRA next", body: "The Edward Jones Roth IRA ($121,644, about 18% in cash) can follow the joint account. Starting its paperwork now saves a second kickoff.", status: "Meeting priority", provenance: "Synthesized from Plaid holdings + the September statement" },
        { tone: "risk", title: "Beneficiary form unsigned", body: "HD-2481 has been open nine days. Until the signed form is back, the Roth IRA keeps its current designation.", status: "Open item", provenance: "Synthesized from help desk + email" },
        { tone: "context", title: "Self-employed saver", body: "Ada funds the SEP IRA from consulting income. A tax year's contribution can go in up to that year's filing deadline.", status: "Planning", provenance: "Synthesized from account records" },
        { tone: "healthy", title: "SEP IRA on model", body: "The SEP IRA has stayed on Meridian Growth 80/20 since its first contribution three years ago.", status: "On track", provenance: "Synthesized from REQ-00000901 + positions" },
      ],
    },
    taxBudget: {
      budget: 3_000,
      realized: 0,
      note: "Ada's accounts are tax-deferred (SEP IRA) and tax-free (Roth IRA), so trades in them don't count against this budget.",
      prior: 3_000,
    },
  },
  {
    person: "lindqvist-erik",
    portrait: {
      Family: "Widowed; two adult children, Linnea and Johan",
      Goals: "Reliable income from the IRA; leave the rest to his children",
      Communication: "Email; short and to the point",
      Behavior: "Steady; doesn't react to market swings",
      Worry: "Taking the required distribution late or with the wrong withholding",
      Themes: "Required distributions, consolidation, legacy",
    },
    beneficiaries: [
      { account: "acct-007", name: "Linnea Lindqvist", rel: "Child", pct: 50, dob: "02/11/1979" },
      { account: "acct-007", name: "Johan Lindqvist", rel: "Child", pct: 50, dob: "10/30/1982" },
      { account: "acct-008", name: "Linnea Lindqvist", rel: "Child (TOD)", pct: 50, dob: "02/11/1979" },
      { account: "acct-008", name: "Johan Lindqvist", rel: "Child (TOD)", pct: 50, dob: "10/30/1982" },
    ],
    prep: {
      lastMeeting: { daysAgo: 6, label: "RMD confirmation call" },
      recentSignals: [
        "This year's RMD sent with 10% federal withholding (REQ-00001038)",
        "Fidelity transfer accepted; settlement expected in a few days",
        "$50 IRA maintenance fee charged in error and credited",
      ],
      openItems: [
        "Invest the Fidelity account in Meridian Income once it lands",
        "Set next year's RMD date and withholding",
        "Check the next statement for the maintenance fee",
      ],
      talkingPoints: [
        "Confirm this year's distribution arrived as expected",
        "Invest the Fidelity account in Meridian Income",
        "Next year's RMD timing and withholding",
        "Beneficiaries: Linnea and Johan on both accounts",
      ],
      notes: "Prefers email follow-ups; keep the meeting short.",
    },
    dualView: {
      label: "Distribution year, one firm",
      description: "A retiree's required distribution done, a small account moving in, and a fee error put right.",
      meetingLabel: "Annual review · sample agenda",
      brief:
        "This year's required minimum distribution is done: REQ-00001038 raised $42,300 and it went out with 10% federal withholding. The Fidelity account is in transfer. Confirm next year's distribution plan and the $50 fee credit, then invest the Fidelity account in Meridian Income when it lands.",
      realTime: [
        { daysAgo: 1, text: "Raise-cash request REQ-00001038 completed: $42,300 for the RMD", source: "Trade Request · completed" },
        { daysAgo: 2, text: "Fidelity transfer accepted (CTL-10427); settlement in a few days", source: "Transfer Tracker" },
        { daysAgo: 5, text: "RMD distributed with 10% federal withholding", source: "CRM task" },
        { daysAgo: 6, text: "Confirmed the RMD amount by phone", source: "CRM call log" },
        { daysAgo: 7, text: "Asked for this year's RMD, same withholding as last year", source: "Email" },
      ],
      historical: [
        { daysAgo: 21, text: "IRA maintenance fee charged in error; $50 credited", source: "Operations fee request" },
        { daysAgo: { funded: "acct-007" }, text: "Traditional IRA invested in Meridian Income (REQ-00000902)", source: "Trade Request" },
        { daysAgo: { opened: "acct-007" }, text: "Traditional IRA opened with an employer-plan rollover", source: "Custodian account record" },
      ],
      insights: [
        { tone: "opportunity", title: "Set next year's RMD now", body: "Erik takes his required distribution from the Traditional IRA every year. Fixing the date and withholding at this review avoids a year-end rush.", status: "Meeting priority", provenance: "Synthesized from REQ-00001038 + call log" },
        { tone: "risk", title: "Fee error already once this year", body: "The $50 IRA maintenance fee was charged in error and credited. Check the next statement so it doesn't come back.", status: "Watch", provenance: "Synthesized from the operations fee request" },
        { tone: "context", title: "Consolidating at one firm", body: "The Fidelity individual account ($58,200) is in transfer. Once it lands, the RMD, the tax report and the beneficiaries are in one place.", status: "Context", provenance: "Synthesized from the Transfer Tracker record" },
        { tone: "healthy", title: "This year's distribution is done", body: "The RMD went out with the withholding Erik asked for, and the task is closed.", status: "On track", provenance: "Synthesized from CRM task + trade request" },
      ],
    },
    taxBudget: {
      budget: 5_000,
      realized: 0,
      note: "The Fidelity positions arrive in kind. RMD withdrawals are income, not realized gains, so they don't count here.",
      prior: 5_000,
    },
  },
  {
    person: "brennan-maeve",
    portrait: {
      Family: "Single; one adult daughter, Niamh",
      Goals: "Retire at 60 with the rollover IRA and the Schwab account working together",
      Communication: "Email; wants the numbers in writing",
      Behavior: "Analytical; checks every statement line",
      Worry: "Fees and taxes eating into returns",
      Themes: "Tax-loss harvesting, fee transparency, consolidation",
    },
    beneficiaries: [
      { account: "acct-010", name: "Niamh Brennan", rel: "Child", pct: 100, dob: "06/09/1996" },
      { account: "acct-009", name: "Niamh Brennan", rel: "Child (TOD)", pct: 100, dob: "06/09/1996" },
    ],
    prep: {
      lastMeeting: { daysAgo: 8, label: "Tax-loss harvesting call" },
      recentSignals: [
        "Questioned the Q3 advisory fee (HD-2474)",
        "Service-guarantee waiver for Q3 waiting for approval",
        "Tax-loss harvest in the bond funds executing (REQ-00001041)",
        "Schwab individual account submitted for transfer",
      ],
      openItems: [
        "Send the written Q3 fee explanation",
        "Decision on the Q3 fee waiver",
        "Show the harvest against her realized-gains budget",
      ],
      talkingPoints: [
        "Q3 fee: the average daily balance, the household tier and the waiver",
        "Losses harvested so far and the realized-gains budget",
        "Schwab transfer timing",
      ],
      notes: "Send the fee math before the meeting; she will have read it.",
    },
    dualView: {
      label: "Fees, taxes and a transfer",
      description: "A fee question, a pending waiver, a harvest executing and a Schwab account on its way.",
      meetingLabel: "Tax planning · sample agenda",
      brief:
        "Maeve questioned the Q3 advisory fee (HD-2474), and a one-quarter service-guarantee waiver for the delayed rebalance is waiting for approval. The tax-loss harvest in the bond funds is executing (REQ-00001041), and the Schwab individual account was submitted for transfer. Send the written fee explanation first, then show the harvest against her realized-gains budget.",
      realTime: [
        { daysAgo: 0, text: "Tax-loss harvest REQ-00001041 executing: selling the bond funds", source: "Trade Request · executing" },
        { daysAgo: 1, text: "Schwab individual account submitted for transfer (CTL-10431)", source: "Transfer Tracker" },
        { daysAgo: 2, text: "Service-guarantee waiver for Q3 requested, awaiting approval", source: "Operations fee request" },
        { daysAgo: 3, text: "Walked through the Q3 fee: average daily balance and tier", source: "CRM call log" },
        { daysAgo: 3, text: "Help desk ticket HD-2474 opened: question about the Q3 fee", source: "Help desk" },
      ],
      historical: [
        { daysAgo: 8, text: "Agreed to harvest bond-fund losses before year end", source: "CRM call log" },
        { daysAgo: { funded: "acct-010" }, text: "Rollover IRA invested in Meridian Balanced 60/40 (REQ-00000903)", source: "Trade Request" },
        { daysAgo: { opened: "acct-010" }, text: "Rollover IRA opened for her former employer's 401(k)", source: "Custodian account record" },
      ],
      insights: [
        { tone: "risk", title: "Fee trust is on the line", body: "A fee question and a pending waiver in the same week. Answer in writing first; she asked for the math.", status: "Open item", provenance: "Synthesized from help desk + fee request" },
        { tone: "opportunity", title: "Harvest keeps the year in budget", body: "Losses harvested in the bond funds offset gains realized elsewhere this year, keeping her under the realized-gains budget.", status: "Meeting priority", provenance: "Synthesized from REQ-00001041 + tax budget" },
        { tone: "context", title: "California resident", body: "Her trade requests carry California residence, and realized gains face state tax as well, so the budget matters more.", status: "Context", provenance: "Synthesized from trade request records" },
        { tone: "healthy", title: "Rollover IRA on model", body: "The Rollover IRA has stayed on Meridian Balanced 60/40 since it was funded.", status: "On track", provenance: "Synthesized from REQ-00000903 + positions" },
      ],
    },
    taxBudget: {
      budget: 15_000,
      realized: 9_240,
      note: "Bond-fund losses harvested now (REQ-00001041) bring net realized gains down; keep the year under $15,000.",
      prior: 12_000,
    },
  },
];


// --- Reminders: the showcase households' decisions and queued client nudges (the Reminders tab, Smart Nudges and the
// Decision Center read them through lib/data/workflow.ts) ---

export interface ShowcaseTask {
  desc: string;
  assignee: { kind: "group" | "person"; label: string };
  status: "todo" | "in_progress" | "blocked" | "done";
  priority: "low" | "normal" | "high";
  createdBy: string;
  createdDaysAgo: number;
  docs?: Array<{ code: string; status: "needed" | "prepared" | "sent" | "signed" }>;
  needLabel?: string;
}

export interface ShowcaseDecision {
  household: string;
  meeting: { label: string; daysAgo: number };
  items: Array<{
    what: string;
    rec: string;
    owner: { kind: "group" | "person"; label: string };
    status: "open" | "snoozed" | "decided";
    downstream: string;
    tasks: ShowcaseTask[];
  }>;
}

export interface ShowcaseNudge {
  person: string;
  channel: "email" | "text" | "portal" | "phone_prep";
  subject: string;
  when: string;
  templateId: string;
  status: "ready" | "scheduled" | "sent";
  body: string;
}

export const SHOWCASE_DECISIONS: ShowcaseDecision[] = [
  {
    household: "okafor",
    meeting: { label: "Statement review", daysAgo: 21 },
    items: [
      {
        what: "Bring the three Edward Jones accounts to the firm",
        rec: "Move the joint account first, then Ada's Roth IRA and Kofi's individual account",
        owner: { kind: "person", label: "Rachel Moss" },
        status: "decided",
        downstream: "When decided → transfer paperwork for each account, then rebalance into Growth 80/20",
        tasks: [
          { desc: "Rebalance the joint account into Growth 80/20 after settlement", assignee: { kind: "person", label: "Rachel Moss" }, status: "todo", priority: "normal", createdBy: "Rachel Moss", createdDaysAgo: 3 },
          { desc: "Prepare transfer paperwork for the Roth IRA and individual account", assignee: { kind: "group", label: "Operations" }, status: "todo", priority: "normal", createdBy: "Rachel Moss", createdDaysAgo: 21, docs: [{ code: "acat", status: "needed" }], needLabel: "Account transfer → ACAT" },
        ],
      },
      {
        what: "Keep the NVDA position in Kofi's individual account",
        rec: "Hold, don't add; the trade desk's exclusion stays on file",
        owner: { kind: "group", label: "Advisory" },
        status: "decided",
        downstream: "The exclusion travels with the account when it moves",
        tasks: [],
      },
      {
        what: "Update the Roth IRA beneficiaries",
        rec: "Name Amara and Tobi, 50/50, before the Roth IRA moves",
        owner: { kind: "group", label: "Client Service" },
        status: "open",
        downstream: "When decided → signed beneficiary form to the custodian",
        tasks: [
          { desc: "Collect Ada's signed beneficiary form", assignee: { kind: "group", label: "Client Service" }, status: "in_progress", priority: "normal", createdBy: "Helen Carver", createdDaysAgo: 9, docs: [{ code: "beneficiary", status: "sent" }], needLabel: "Beneficiary change → designation form" },
        ],
      },
    ],
  },
  {
    household: "lindqvist",
    meeting: { label: "RMD confirmation call", daysAgo: 6 },
    items: [
      {
        what: "Take this year's required distribution from the Traditional IRA",
        rec: "$42,300 with 10% federal withholding, as last year",
        owner: { kind: "person", label: "Dana Pruitt" },
        status: "decided",
        downstream: "When decided → raise cash, then distribute",
        tasks: [
          { desc: "Distribute the RMD with 10% federal withholding", assignee: { kind: "group", label: "Operations" }, status: "done", priority: "high", createdBy: "Dana Pruitt", createdDaysAgo: 7, docs: [{ code: "iradist", status: "signed" }], needLabel: "IRA distribution → distribution form" },
        ],
      },
      {
        what: "Invest the Fidelity account when it lands",
        rec: "Meridian Income, the same model as the IRA",
        owner: { kind: "group", label: "Advisory" },
        status: "open",
        downstream: "When decided → Initial Funding request to the trade desk",
        tasks: [],
      },
    ],
  },
  {
    household: "brennan",
    meeting: { label: "Tax-loss harvesting call", daysAgo: 8 },
    items: [
      {
        what: "Harvest losses in the bond funds before year end",
        rec: "Sell the bond funds at a loss and buy similar funds",
        owner: { kind: "person", label: "Rachel Moss" },
        status: "decided",
        downstream: "When decided → liquidate request to the trade desk",
        tasks: [
          { desc: "Execute the tax-loss harvest (REQ-00001041)", assignee: { kind: "group", label: "Trade Desk" }, status: "in_progress", priority: "normal", createdBy: "Rachel Moss", createdDaysAgo: 8 },
        ],
      },
      {
        what: "Waive the Q3 advisory fee under the service guarantee",
        rec: "One quarter, for the delayed rebalance",
        owner: { kind: "group", label: "Operations" },
        status: "open",
        downstream: "When decided → fee credit on the next billing run",
        tasks: [
          { desc: "Send Maeve the written Q3 fee explanation", assignee: { kind: "group", label: "Client Service" }, status: "todo", priority: "normal", createdBy: "Helen Carver", createdDaysAgo: 3 },
        ],
      },
    ],
  },
];

export const SHOWCASE_NUDGES: ShowcaseNudge[] = [
  {
    person: "okafor-ada",
    channel: "email",
    subject: "Reminder: sign your Roth IRA beneficiary form",
    when: "Tomorrow, 9:00 AM",
    templateId: "tpl-docsign",
    status: "scheduled",
    body: "Hi Ada, a reminder that the beneficiary form for your Roth IRA is waiting for your signature. Sign where flagged and send it back through the portal, and Helen will take it from there.",
  },
  {
    person: "okafor-kofi",
    channel: "email",
    subject: "Your Edward Jones transfer: what to expect this week",
    when: "Ready now",
    templateId: "tpl-transition",
    status: "ready",
    body: "Hi Kofi, most positions from the Edward Jones joint account arrive in kind this week. The Bridge Builder fund is sold first and comes over as cash. Once everything settles, we rebalance into your Growth 80/20 model.",
  },
  {
    person: "lindqvist-erik",
    channel: "email",
    subject: "Your required distribution has been sent",
    when: "Sent 5 days ago",
    templateId: "tpl-review",
    status: "sent",
    body: "Hi Erik, this year's required minimum distribution has been sent with 10% federal withholding, as you asked. You'll see it on your next statement.",
  },
  {
    person: "lindqvist-erik",
    channel: "phone_prep",
    subject: "Call prep: next year's distribution date",
    when: "Before the annual review",
    templateId: "tpl-review",
    status: "ready",
    body: "Confirm next year's RMD date and withholding, and invest the Fidelity account in Meridian Income once it lands.",
  },
  {
    person: "brennan-maeve",
    channel: "email",
    subject: "Your Q3 fee, explained",
    when: "Ready now",
    templateId: "tpl-review",
    status: "ready",
    body: "Hi Maeve, here is how your Q3 advisory fee was calculated: the average daily balance across your accounts, at your household's tier. We've also asked to waive this quarter's fee for the delayed rebalance and will confirm once it's approved.",
  },
  {
    person: "brennan-maeve",
    channel: "text",
    subject: "Schwab transfer submitted",
    when: "Sent yesterday",
    templateId: "tpl-transition",
    status: "sent",
    body: "Hi Maeve, your Schwab account transfer was submitted today. Most transfers complete in about a week; we'll text you when it lands.",
  },
];
