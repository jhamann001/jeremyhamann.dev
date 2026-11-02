import { describe, expect, it } from "vitest";

// The PURE meeting-prep context assembler — the module that decides what the
// model is allowed to see. No DB, no clock, no server-only: it imports straight
// into the node env. These tests are the bulk of the feature's value, because
// every truncation rule here is a silent-data-loss bug if it drifts.

import {
  ACCOUNT_ITEM_CAP,
  ACTIVITY_ITEM_CAP,
  ACTIVITY_NOTE_CHAR_CAP,
  assembleMeetingPrepContext,
  CONTEXT_CHAR_BUDGET,
  DEAL_ITEM_CAP,
  EMAIL_BODY_CHAR_CAP,
  EMAIL_ITEM_CAP,
  MEETING_PREP_INSTRUCTION,
  maskAccount,
  NO_LINKED_CLIENT,
  NONE_ON_FILE,
  OMITTED_FOR_BUDGET,
  TASK_DESCRIPTION_CHAR_CAP,
  TASK_ITEM_CAP,
  TRANSFER_ITEM_CAP,
  type MeetingPrepSources,
} from "@/lib/ai/meeting-prep-context";

const MEETING = {
  clientName: "Stone Family Trust",
  advisorName: "Mason O'Reilly",
  meetingType: "Quarterly review",
  when: "Tomorrow · 10:30 AM ET",
};

const CLIENT = {
  name: "Sam Stone",
  householdName: "Stone Household",
  householdStatus: "Active",
  householdStage: "Client",
  leadAdvisorEmail: "dana@example.com",
};

function sources(over: Partial<MeetingPrepSources> = {}): MeetingPrepSources {
  return {
    meeting: MEETING,
    client: CLIENT,
    aumTotal: null,
    accounts: [],
    deals: [],
    transfers: [],
    tasks: [],
    activity: [],
    emails: [],
    ...over,
  };
}

const account = (n: number) => ({
  accountType: "Roth IRA",
  apexAccountNumber: `9876${String(n).padStart(4, "0")}`,
  accountStatus: "OPEN",
  isManaged: true,
  accountAum: 100_000 + n,
  asOf: new Date("2026-07-26T00:00:00.000Z"),
});

const task = (n: number, description = `desc ${n}`) => ({
  subject: `Task ${n}`,
  status: "In Progress",
  priority: "Normal",
  description,
});

const email = (n: number, body = `body ${n}`) => ({
  at: new Date(`2026-07-${String(10 + (n % 15)).padStart(2, "0")}T12:00:00.000Z`),
  subject: `Subject ${n}`,
  body,
});

const activity = (n: number, note = `note ${n}`) => ({
  at: new Date("2026-07-20T12:00:00.000Z"),
  subject: `Call ${n}`,
  ownerName: "Mason O'Reilly",
  note,
});

const HEADERS = [
  "MEETING",
  "CLIENT & HOUSEHOLD",
  "ACCOUNTS & AUM",
  "OPEN DEALS",
  "MONEY IN FLIGHT",
  "OPEN ITEMS",
  "RECENT CALLS & NOTES",
  "RECENT EMAILS",
];

describe("maskAccount", () => {
  it("emits at most the last 4 digits, for long, short, null and empty inputs", () => {
    expect(maskAccount("987612345678")).toBe("••5678");
    expect(maskAccount("1234")).toBe("••1234");
    expect(maskAccount("12")).toBe("••12");
    expect(maskAccount(null)).toBe("••••");
    expect(maskAccount("")).toBe("••••");
    expect(maskAccount("   ")).toBe("••••");
  });

  it("never leaks the leading digits of a real account number", () => {
    const full = "80012345678";
    expect(maskAccount(full)).not.toContain("8001");
    expect(maskAccount(full).length).toBeLessThanOrEqual(6);
  });
});

describe("assembleMeetingPrepContext — structure", () => {
  it("emits every block header, in the documented order", () => {
    const { text } = assembleMeetingPrepContext(sources());
    const positions = HEADERS.map((h) => text.indexOf(`=== ${h} ===`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("emits an EMPTY block as `(none on file)` rather than omitting it", () => {
    const { text } = assembleMeetingPrepContext(sources());
    // Six data blocks are empty here; each must carry the marker.
    expect(text.split(NONE_ON_FILE).length - 1).toBe(6);
    expect(text).toContain(`=== RECENT EMAILS ===\n${NONE_ON_FILE}`);
  });

  it("carries the meeting facts and the household facts", () => {
    const { text } = assembleMeetingPrepContext(sources());
    expect(text).toContain("Tomorrow · 10:30 AM ET");
    expect(text).toContain("Quarterly review");
    expect(text).toContain("Mason O'Reilly");
    expect(text).toContain("Stone Household");
    expect(text).toContain("dana@example.com");
  });

  it("masks account numbers to the last 4 before the model ever sees them", () => {
    const { text } = assembleMeetingPrepContext(
      sources({ accounts: [account(1)], aumTotal: 100_001 }),
    );
    expect(text).toContain("••0001");
    expect(text).not.toContain("98760001");
  });

  it("the instruction is a fixed string with no client data interpolated", () => {
    expect(MEETING_PREP_INSTRUCTION).toContain("Talking points");
    expect(MEETING_PREP_INSTRUCTION).toContain("[PLACEHOLDER]");
    expect(MEETING_PREP_INSTRUCTION).not.toContain("Stone");
  });
});

describe("assembleMeetingPrepContext — no linked client (SC-3)", () => {
  const unlinked = sources({
    client: null,
    // Even if the fetcher handed us data, an unlinked appointment must not
    // render it — the guard is in the assembler, not only upstream.
    accounts: [account(1)],
    tasks: [task(1)],
    emails: [email(1)],
  });

  it("does not throw and still produces every block", () => {
    const res = assembleMeetingPrepContext(unlinked);
    for (const h of HEADERS) expect(res.text).toContain(`=== ${h} ===`);
  });

  it("states the absence of a linked client record explicitly", () => {
    expect(assembleMeetingPrepContext(unlinked).text).toContain(NO_LINKED_CLIENT);
  });

  it("renders every client-dependent block as `(none on file)` and counts zero", () => {
    const res = assembleMeetingPrepContext(unlinked);
    // The six data blocks PLUS the client/household block itself — only MEETING
    // has content when there is no linked client record.
    expect(res.text.split(NONE_ON_FILE).length - 1).toBe(7);
    expect(res.text).toContain(`=== CLIENT & HOUSEHOLD ===\n${NONE_ON_FILE}`);
    expect(res.sources).toEqual({
      accounts: 0,
      deals: 0,
      transfers: 0,
      tasks: 0,
      activity: 0,
      emails: 0,
    });
  });
});

describe("assembleMeetingPrepContext — item caps drop the OLDEST", () => {
  it("caps accounts and notes how many were dropped", () => {
    const accounts = Array.from({ length: ACCOUNT_ITEM_CAP + 3 }, (_, i) => account(i));
    const res = assembleMeetingPrepContext(sources({ accounts }));
    expect(res.sources.accounts).toBe(ACCOUNT_ITEM_CAP);
    expect(res.text).toContain("(+3 older not shown)");
    expect(res.truncated).toBe(true);
  });

  it("keeps the head of the list (most recent) and drops the tail (oldest)", () => {
    // Lists arrive most-recent-first, so the LAST entries are the oldest.
    const emails = Array.from({ length: EMAIL_ITEM_CAP + 2 }, (_, i) => email(i));
    const res = assembleMeetingPrepContext(sources({ emails }));
    expect(res.text).toContain("Subject 0"); // newest, kept
    expect(res.text).toContain(`Subject ${EMAIL_ITEM_CAP - 1}`); // last kept
    expect(res.text).not.toContain(`Subject ${EMAIL_ITEM_CAP}`); // oldest, dropped
    expect(res.sources.emails).toBe(EMAIL_ITEM_CAP);
  });

  it("caps deals, transfers, tasks and activity at their documented limits", () => {
    const res = assembleMeetingPrepContext(
      sources({
        deals: Array.from({ length: DEAL_ITEM_CAP + 1 }, () => ({
          name: "Rollover",
          stage: "COMMITTED",
          amount: 500_000,
          closeDate: new Date("2026-08-01T00:00:00.000Z"),
          fundingType: "ACAT",
          transferringFirm: "Schwab",
          ownerName: "Mason O'Reilly",
        })),
        transfers: Array.from({ length: TRANSFER_ITEM_CAP + 1 }, () => ({
          stage: "IN_TRANSFER",
          daysInStage: 4,
          value: 250_000,
          fundingType: "ACAT",
          nextStep: "Chase Apex",
          accountsOpenedAtApex: true,
          fundingPlanComplete: true,
          fundingInitiated: false,
          cashInFlight: false,
          acatLinked: true,
          closeoutDone: 2,
          closeoutTotal: 7,
        })),
        tasks: Array.from({ length: TASK_ITEM_CAP + 1 }, (_, i) => task(i)),
        activity: Array.from({ length: ACTIVITY_ITEM_CAP + 1 }, (_, i) => activity(i)),
      }),
    );
    expect(res.sources.deals).toBe(DEAL_ITEM_CAP);
    expect(res.sources.transfers).toBe(TRANSFER_ITEM_CAP);
    expect(res.sources.tasks).toBe(TASK_ITEM_CAP);
    expect(res.sources.activity).toBe(ACTIVITY_ITEM_CAP);
  });

  it("drops WHOLE items — never half a record", () => {
    const emails = Array.from({ length: EMAIL_ITEM_CAP + 1 }, (_, i) => email(i));
    const res = assembleMeetingPrepContext(sources({ emails }));
    const rendered = res.text
      .split("=== RECENT EMAILS ===")[1]
      .split("\n")
      .filter((l) => l.startsWith("- "));
    // Every rendered line is a complete record (has both a date and a subject).
    for (const l of rendered) expect(l).toMatch(/^- .+ · Subject \d+/);
  });
});

describe("assembleMeetingPrepContext — field caps", () => {
  it("cuts a long task description at exactly the cap and appends an ellipsis", () => {
    const long = "x".repeat(TASK_DESCRIPTION_CHAR_CAP + 50);
    const res = assembleMeetingPrepContext(sources({ tasks: [task(1, long)] }));
    expect(res.text).toContain(`${"x".repeat(TASK_DESCRIPTION_CHAR_CAP)}…`);
    expect(res.text).not.toContain("x".repeat(TASK_DESCRIPTION_CHAR_CAP + 1));
    expect(res.truncated).toBe(true);
  });

  it("cuts long activity notes and email bodies at their caps", () => {
    const res = assembleMeetingPrepContext(
      sources({
        activity: [activity(1, "n".repeat(ACTIVITY_NOTE_CHAR_CAP + 20))],
        emails: [email(1, "b".repeat(EMAIL_BODY_CHAR_CAP + 20))],
      }),
    );
    expect(res.text).toContain(`${"n".repeat(ACTIVITY_NOTE_CHAR_CAP)}…`);
    expect(res.text).toContain(`${"b".repeat(EMAIL_BODY_CHAR_CAP)}…`);
    expect(res.text).not.toContain("n".repeat(ACTIVITY_NOTE_CHAR_CAP + 1));
  });

  it("leaves a short field untouched (no stray ellipsis)", () => {
    const res = assembleMeetingPrepContext(sources({ tasks: [task(1, "short note")] }));
    expect(res.text).toContain("short note");
    expect(res.text).not.toContain("short note…");
    expect(res.truncated).toBe(false);
  });
});

describe("assembleMeetingPrepContext — global budget", () => {
  // Fill every capped block with maximum-length fields. With today's caps this
  // still lands well under CONTEXT_CHAR_BUDGET — the budget is a BACKSTOP — so
  // the eviction path is driven with an explicit small budget below.
  const fat = sources({
    accounts: Array.from({ length: ACCOUNT_ITEM_CAP }, (_, i) => account(i)),
    deals: Array.from({ length: DEAL_ITEM_CAP }, () => ({
      name: "Rollover",
      stage: "COMMITTED",
      amount: 500_000,
      closeDate: new Date("2026-08-01T00:00:00.000Z"),
      fundingType: "ACAT",
      transferringFirm: "Schwab",
      ownerName: "Mason O'Reilly",
    })),
    tasks: Array.from({ length: TASK_ITEM_CAP }, (_, i) =>
      task(i, "t".repeat(TASK_DESCRIPTION_CHAR_CAP)),
    ),
    activity: Array.from({ length: ACTIVITY_ITEM_CAP }, (_, i) =>
      activity(i, "a".repeat(ACTIVITY_NOTE_CHAR_CAP)),
    ),
    emails: Array.from({ length: EMAIL_ITEM_CAP }, (_, i) =>
      email(i, "e".repeat(EMAIL_BODY_CHAR_CAP)),
    ),
  });

  it("a maximally-full context stays inside the real budget with no eviction", () => {
    const res = assembleMeetingPrepContext(fat);
    expect(res.chars).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET);
    expect(res.chars).toBe(res.text.length);
    expect(res.text).not.toContain(OMITTED_FOR_BUDGET);
  });

  it("drops blocks BOTTOM-UP (emails first) when the budget binds", () => {
    const res = assembleMeetingPrepContext(fat, 12_000);
    expect(res.text).toContain(`=== RECENT EMAILS ===\n${OMITTED_FOR_BUDGET}`);
    expect(res.sources.emails).toBe(0);
    expect(res.truncated).toBe(true);
    // The blocks ABOVE the evicted one survive until they too are needed.
    expect(res.sources.accounts).toBe(ACCOUNT_ITEM_CAP);
    expect(res.chars).toBeLessThanOrEqual(12_000);
  });

  it("evicts in order — emails, then activity, then tasks", () => {
    const res = assembleMeetingPrepContext(fat, 4_000);
    const omittedBlocks = HEADERS.filter((h) =>
      res.text.includes(`=== ${h} ===\n${OMITTED_FOR_BUDGET}`),
    );
    expect(omittedBlocks).toContain("RECENT EMAILS");
    expect(omittedBlocks).toContain("RECENT CALLS & NOTES");
    expect(omittedBlocks).toContain("OPEN ITEMS");
    expect(omittedBlocks).not.toContain("MEETING");
    expect(omittedBlocks).not.toContain("CLIENT & HOUSEHOLD");
  });

  it("NEVER drops the MEETING or CLIENT & HOUSEHOLD blocks, even at budget 0", () => {
    const res = assembleMeetingPrepContext(fat, 0);
    expect(res.text).toContain("Tomorrow · 10:30 AM ET");
    expect(res.text).toContain("Stone Household");
    expect(res.text).not.toContain(`=== MEETING ===\n${OMITTED_FOR_BUDGET}`);
    expect(res.text).not.toContain(`=== CLIENT & HOUSEHOLD ===\n${OMITTED_FOR_BUDGET}`);
    expect(res.sources).toEqual({
      accounts: 0,
      deals: 0,
      transfers: 0,
      tasks: 0,
      activity: 0,
      emails: 0,
    });
  });

  it("reported counts describe what was ACTUALLY rendered", () => {
    const res = assembleMeetingPrepContext(fat, 12_000);
    expect(res.sources.emails).toBe(0); // evicted
    expect(res.sources.accounts).toBe(ACCOUNT_ITEM_CAP); // survived
  });
});
