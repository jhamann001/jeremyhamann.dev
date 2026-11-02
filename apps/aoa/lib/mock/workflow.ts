import type {
  Decision,
  Nudge,
  NudgeTemplate,
  PipelineStats,
} from "@/lib/data/workflow-types";

// Deterministic Workflow-pipeline fixtures (Phase C, TDD §3, ADR-4).
// Re-keyed onto the 5 SEED households/clients/advisors (NOT the mockup personas)
// so the demo stays coherent with Phase B:
//   Households: HH-1001 Stone Family Trust · HH-1002 Nguyen Household ·
//               HH-1003 Okafor Household · HH-2001 Walker Household ·
//               HH-2002 Patel Family
//   Clients:    C-1 Sam Stone · C-2 Jo Stone · C-3 Minh Nguyen · C-4 Ada Okafor ·
//               C-5 Neil Walker · C-6 Asha Patel
//   Advisors:   Avery Stone · Gwen Kuhlman
//   Groups:     Operations · Client Service · Advisory · Trade Desk
// No randomness / no Date — renders are stable. Wired to real sources in Phase D
// (meeting/notes ingestion → app.decision/app.task/app.nudge); the seam signature stays.

export const DECISIONS: Decision[] = [
  {
    id: "d-1001",
    householdId: "HH-1001",
    householdName: "Stone Family Trust",
    meeting: "Quarterly review · Jun 24",
    items: [
      {
        id: "i-1001a",
        what: "Liquidate concentrated tech position to fund trust distribution",
        rec: "Trim NVDA to 5% of portfolio; journal proceeds to the trust checking account",
        owner: { kind: "person", label: "Avery Stone" },
        status: "decided",
        downstream: "When decided → initiate ACAT + cash journal, then notify trustee",
        tasks: [
          {
            id: "t-seed-1",
            desc: "Prepare ACAT + journal paperwork for the trust distribution",
            assignee: { kind: "group", label: "Operations" },
            status: "in_progress",
            priority: "high",
            createdBy: "Avery Stone",
            createdAt: "2026-06-24",
            needLabel: "Liquidation → ACAT + journal",
            docs: [
              { code: "acat", status: "prepared" },
              { code: "journal", status: "needed" },
            ],
          },
          {
            id: "t-seed-2",
            desc: "Confirm Certification of Trust on file before distribution",
            assignee: { kind: "group", label: "Client Service" },
            status: "todo",
            priority: "normal",
            createdBy: "Avery Stone",
            createdAt: "2026-06-24",
            docs: [{ code: "trustcert", status: "signed" }],
          },
        ],
      },
      {
        id: "i-1001b",
        what: "Increase bond allocation to reduce portfolio volatility",
        rec: "Shift 8% from equities into short-duration fixed income",
        owner: { kind: "group", label: "Advisory" },
        status: "open",
        downstream: "When decided → build rebalance basket for Trade Desk",
        tasks: [],
      },
    ],
  },
  {
    id: "d-1002",
    householdId: "HH-1002",
    householdName: "Nguyen Household",
    meeting: "Financial plan check-in · Jun 18",
    items: [
      {
        id: "i-1002a",
        what: "Set up recurring ACH contributions to the taxable account",
        rec: "Establish $2,000/mo ACH from the client's primary bank",
        owner: { kind: "group", label: "Operations" },
        status: "decided",
        downstream: "When decided → collect ACH authorization + proof of bank ownership",
        tasks: [
          {
            id: "t-seed-3",
            desc: "Send ACH authorization form to Minh Nguyen and collect supporting docs",
            assignee: { kind: "group", label: "Operations" },
            status: "todo",
            priority: "normal",
            createdBy: "Avery Stone",
            createdAt: "2026-06-18",
            needLabel: "Bank funding → ACH",
            docs: [{ code: "ach", status: "needed" }],
          },
        ],
      },
    ],
  },
  {
    id: "d-1003",
    householdId: "HH-1003",
    householdName: "Okafor Household",
    meeting: "Onboarding kickoff · Jun 12",
    items: [
      {
        id: "i-1003a",
        what: "Transition brokerage assets from prior custodian",
        rec: "Open Apex account and initiate ACAT for the full brokerage transfer",
        owner: { kind: "group", label: "Operations" },
        status: "snoozed",
        snoozeUntil: "2026-07-10",
        downstream: "When decided → open account, prepare transition kit + ACAT",
        tasks: [],
      },
      {
        id: "i-1003b",
        what: "Confirm instructions for positions excluded from the partial ACAT",
        rec: "Proceed with partial-ACAT paperwork for transferable assets and document the client’s direction for excluded positions",
        category: "Asset transfer",
        source: { label: "Asset Transfer · linked case", href: "/asset-transfer" },
        owner: { kind: "group", label: "Client Service" },
        status: "open",
        downstream: "When decided → write the resolution back to Asset Transfer and release the submission checklist",
        tasks: [
          {
            id: "t-seed-transfer-decision",
            desc: "Confirm the client’s instructions for positions excluded from the partial ACAT",
            assignee: { kind: "group", label: "Client Service" },
            status: "todo",
            priority: "high",
            createdBy: "Asset Mapper · Operations",
            createdAt: "2026-09-03",
            needLabel: "Resolve partial-ACAT exception",
          },
        ],
      },
    ],
  },
  {
    id: "d-2001",
    householdId: "HH-2001",
    householdName: "Walker Household",
    meeting: "Retirement income review · Jun 20",
    items: [
      {
        id: "i-2001a",
        what: "Begin scheduled IRA distributions for retirement income",
        rec: "Set up $3,500/mo IRA distribution with 12% federal withholding",
        owner: { kind: "person", label: "Gwen Kuhlman" },
        status: "decided",
        downstream: "When decided → file IRA distribution request, confirm withholding",
        tasks: [
          {
            id: "t-seed-4",
            desc: "File IRA distribution request for Neil Walker",
            assignee: { kind: "group", label: "Operations" },
            status: "blocked",
            priority: "high",
            createdBy: "Gwen Kuhlman",
            createdAt: "2026-06-20",
            needLabel: "IRA distribution",
            docs: [{ code: "iradist", status: "needed" }],
          },
        ],
      },
      {
        id: "i-2001b",
        what: "Update beneficiary designations after life event",
        rec: "Refresh primary and contingent beneficiaries across all accounts",
        owner: { kind: "group", label: "Client Service" },
        status: "open",
        downstream: "When decided → send beneficiary designation for signature",
        tasks: [],
      },
    ],
  },
  {
    id: "d-2002",
    householdId: "HH-2002",
    householdName: "Patel Family",
    meeting: "Portfolio review · Jun 15",
    items: [
      {
        id: "i-2002a",
        what: "Enable options trading for a covered-call income sleeve",
        rec: "Apply for level-1 options approval on the taxable account",
        owner: { kind: "group", label: "Trade Desk" },
        status: "open",
        downstream: "When decided → submit options application for approval",
        tasks: [],
      },
    ],
  },
];

export const NUDGE_QUEUE: Nudge[] = [
  {
    id: "n-1",
    clientId: "C-1",
    client: "Sam Stone",
    channel: "email",
    subject: "Trust distribution paperwork ready to sign",
    when: "Ready now",
    templateId: "tpl-docsign",
    status: "ready",
    body: "Hi Sam, the ACAT and journal paperwork for the trust distribution is ready. You'll receive a DocuSign envelope shortly — please review and sign at your convenience.",
  },
  {
    id: "n-2",
    clientId: "C-3",
    client: "Minh Nguyen",
    channel: "text",
    subject: "Quick note on your monthly contribution",
    when: "Ready now",
    templateId: "tpl-ach",
    status: "ready",
    body: "Hi Minh, to start your $2,000/mo contribution we just need a signed ACH form plus a voided check or recent bank statement. I'll send the link over.",
  },
  {
    id: "n-3",
    clientId: "C-4",
    client: "Ada Okafor",
    channel: "portal",
    subject: "Your transfer is on hold pending documents",
    when: "Scheduled · Jul 8",
    templateId: "tpl-transition",
    status: "scheduled",
    body: "Hi Ada, we're ready to move your brokerage assets over. Once you confirm the transition details in the portal, we'll initiate the ACAT transfer.",
  },
  {
    id: "n-4",
    clientId: "C-5",
    client: "Neil Walker",
    channel: "phone_prep",
    subject: "Call prep: retirement income distribution",
    when: "Scheduled · Jul 2",
    templateId: "tpl-review",
    status: "scheduled",
    body: "Talking points for Neil's call: confirm the $3,500/mo distribution amount, 12% federal withholding election, and target start date.",
  },
  {
    id: "n-5",
    clientId: "C-6",
    client: "Asha Patel",
    channel: "email",
    subject: "Follow-up on your covered-call strategy",
    when: "Sent · Jun 16",
    templateId: "tpl-review",
    status: "sent",
    body: "Hi Asha, following up on our portfolio review — I've started the level-1 options application so we can set up the covered-call income sleeve we discussed.",
  },
];

export const NUDGE_TEMPLATES: NudgeTemplate[] = [
  {
    id: "tpl-docsign",
    name: "Paperwork ready to sign",
    desc: "Notify a client that documents are prepared and a DocuSign envelope is on its way.",
    uses: 42,
    lastUsed: "Jun 24",
    channel: "email",
  },
  {
    id: "tpl-ach",
    name: "ACH setup + supporting docs",
    desc: "Request a signed ACH authorization plus proof of bank ownership.",
    uses: 28,
    lastUsed: "Jun 18",
    channel: "text",
  },
  {
    id: "tpl-transition",
    name: "Account transition follow-up",
    desc: "Prompt a new client to confirm transition details so the transfer can begin.",
    uses: 19,
    lastUsed: "Jun 12",
    channel: "portal",
  },
  {
    id: "tpl-review",
    name: "Post-review recap",
    desc: "Summarize decisions and next steps after a client review meeting.",
    uses: 51,
    lastUsed: "Jun 20",
    channel: "email",
  },
];

export const PIPELINE_STATS: PipelineStats = { stalled: 2 };
