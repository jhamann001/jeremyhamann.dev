import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASKS,
  FUNDING_TYPES,
  FUNDING_TYPE_ETA,
  FUNDING_TYPE_LABEL,
  OWNER_PEOPLE,
  ownerNameOptions,
  STAGE_GATES,
  STAGE_LABEL,
  STAGE_ORDER,
  TRANSFER_ACCOUNT_STATUSES,
  TRANSFER_DECISION_CHOICES,
  TRANSFER_OWNERS,
  TRANSFER_SOURCES,
  TRANSFER_STAGES,
  defaultOwnerName,
  isAcatFunding,
  isFallenOff,
  stageLabel,
  visibleTasks,
  stageChecklistTasks,
  missingStageChecklistRows,
  resolveTaskDone,
  resolveTransferValue,
  SYNCED_TASK_DEAL_FLAG,
  STATEMENTS_TITLE,
  ASSET_MAPPER_TITLE,
  fundingSummary,
  compareByClientName,
  matchesFocus,
  buildSearchGroups,
  type SearchRow,
} from "@/lib/data/transfer-types";

// All data invented — no real client information.

describe("transfer enums", () => {
  it("TRANSFER_STAGES holds the three lanes in board order (ticket Slice 1)", () => {
    expect(TRANSFER_STAGES).toEqual(["DECISION", "IN_TRANSFER", "FUNDED"]);
  });

  it("no longer exposes the removed DISCOVERY / ACCOUNTS_OPEN stages", () => {
    expect(TRANSFER_STAGES).not.toContain("DISCOVERY");
    expect(TRANSFER_STAGES).not.toContain("ACCOUNTS_OPEN");
  });

  it("STAGE_ORDER is the board order (same tuple)", () => {
    expect(STAGE_ORDER).toEqual(TRANSFER_STAGES);
  });

  it("TRANSFER_SOURCES is APP then IMPORT (IMPORT reserved)", () => {
    expect(TRANSFER_SOURCES).toEqual(["APP", "IMPORT"]);
  });

  it("TRANSFER_OWNERS holds the three owner kinds", () => {
    expect(TRANSFER_OWNERS).toEqual([
      "OPERATIONS",
      "CLIENT_SERVICE",
      "ADVISOR",
    ]);
  });

  it("TRANSFER_DECISION_CHOICES holds the three human calls", () => {
    expect(TRANSFER_DECISION_CHOICES).toEqual([
      "BRING_IN",
      "LEAVE_GIFT",
      "UNDECIDED",
    ]);
  });

  it("TRANSFER_ACCOUNT_STATUSES holds the two account states", () => {
    expect(TRANSFER_ACCOUNT_STATUSES).toEqual(["TO_OPEN", "OPEN"]);
  });
});

describe("OWNER_PEOPLE + defaultOwnerName (ticket)", () => {
  it("has a non-empty person list for every owner kind (totality)", () => {
    expect(Object.keys(OWNER_PEOPLE).sort()).toEqual(
      [...TRANSFER_OWNERS].sort(),
    );
    for (const kind of TRANSFER_OWNERS) {
      expect(OWNER_PEOPLE[kind].length).toBeGreaterThan(0);
    }
  });

  it("pins the default (index 0) person per kind", () => {
    expect(OWNER_PEOPLE.OPERATIONS[0]).toBe("Jordan Reyes");
    expect(OWNER_PEOPLE.CLIENT_SERVICE[0]).toBe("Helen Carver");
    expect(OWNER_PEOPLE.ADVISOR[0]).toBe("Rachel Moss");
  });

  it("includes the non-default people as extra options", () => {
    expect(OWNER_PEOPLE.OPERATIONS).toContain("Marco Ferreira");
    expect(OWNER_PEOPLE.ADVISOR).toContain("Dana Pruitt");
  });

  it("defaultOwnerName returns index 0 for each kind", () => {
    for (const kind of TRANSFER_OWNERS) {
      expect(defaultOwnerName(kind)).toBe(OWNER_PEOPLE[kind][0]);
    }
  });
});

describe("ownerNameOptions (ticket toolbar option builder)", () => {
  it("leads with '— Unassigned —' and lists the kind's people for a blank owner", () => {
    const opts = ownerNameOptions("OPERATIONS", null);
    expect(opts[0]).toEqual({ value: "", label: "— Unassigned —" });
    expect(opts.map((o) => o.value)).toEqual([
      "",
      "Jordan Reyes",
      "Marco Ferreira",
    ]);
  });

  it("preserves an out-of-list (legacy/free-text) owner name as a selectable option", () => {
    const opts = ownerNameOptions("CLIENT_SERVICE", "Kayden Altenwerth");
    expect(opts.some((o) => o.value === "Kayden Altenwerth")).toBe(true);
    // exactly once, and the current value always matches an option (no orphan value)
    expect(opts.filter((o) => o.value === "Kayden Altenwerth")).toHaveLength(1);
    expect(opts.map((o) => o.value)).toEqual([
      "",
      "Kayden Altenwerth",
      "Helen Carver",
    ]);
  });

  it("does not duplicate an in-list owner name", () => {
    const opts = ownerNameOptions("OPERATIONS", "Marco Ferreira");
    expect(opts.filter((o) => o.value === "Marco Ferreira")).toHaveLength(1);
    expect(opts.map((o) => o.value)).toEqual([
      "",
      "Jordan Reyes",
      "Marco Ferreira",
    ]);
  });
});

describe("funding types (ticket split)", () => {
  it("FUNDING_TYPES holds the seven rails in dropdown order (transfers grouped above cash rails)", () => {
    expect(FUNDING_TYPES).toEqual([
      "ACAT_FULL",
      "ACAT_PARTIAL",
      "DRS",
      "MANUAL",
      "CHECK",
      "WIRE",
      "ACH",
    ]);
  });

  it("no longer exposes the pre-split bare ACAT value", () => {
    expect(FUNDING_TYPES).not.toContain("ACAT");
  });

  it("labels every funding type (totality) with the owner-approved copy", () => {
    expect(Object.keys(FUNDING_TYPE_LABEL).sort()).toEqual(
      [...FUNDING_TYPES].sort(),
    );
    expect(FUNDING_TYPE_LABEL.ACAT_FULL).toBe("ACAT-Full");
    expect(FUNDING_TYPE_LABEL.ACAT_PARTIAL).toBe("ACAT-Partial");
    expect(FUNDING_TYPE_LABEL.DRS).toBe("DRS");
    expect(FUNDING_TYPE_LABEL.CHECK).toBe("Check");
    expect(FUNDING_TYPE_LABEL.WIRE).toBe("Wire");
    expect(FUNDING_TYPE_LABEL.ACH).toBe("ACH");
    expect(FUNDING_TYPE_LABEL.MANUAL).toBe("Manual Transfer");
  });

  it("gives every funding type an ETA entry without inventing a DRS estimate", () => {
    expect(Object.keys(FUNDING_TYPE_ETA).sort()).toEqual(
      [...FUNDING_TYPES].sort(),
    );
    for (const ft of FUNDING_TYPES) {
      if (ft === "DRS") {
        expect(FUNDING_TYPE_ETA[ft]).toBeNull();
      } else {
        expect(FUNDING_TYPE_ETA[ft]?.trim()).toBeTruthy();
      }
    }
  });

  it("pins the owner-provided ETA copy per rail", () => {
    expect(FUNDING_TYPE_ETA.ACAT_FULL).toBe("5 business days");
    expect(FUNDING_TYPE_ETA.ACAT_PARTIAL).toBe("5 business days");
    expect(FUNDING_TYPE_ETA.CHECK).toBe("30 business days");
    expect(FUNDING_TYPE_ETA.WIRE).toBe("1–2 business days");
    expect(FUNDING_TYPE_ETA.ACH).toBe("3–5 business days");
    expect(FUNDING_TYPE_ETA.MANUAL).toBe("3–5 months");
  });

  it("isAcatFunding is true for both ACAT rails only", () => {
    expect(isAcatFunding("ACAT_FULL")).toBe(true);
    expect(isAcatFunding("ACAT_PARTIAL")).toBe(true);
    expect(isAcatFunding("DRS")).toBe(false);
    expect(isAcatFunding("CHECK")).toBe(false);
    expect(isAcatFunding("WIRE")).toBe(false);
    expect(isAcatFunding("ACH")).toBe(false);
    expect(isAcatFunding("MANUAL")).toBe(false);
    expect(isAcatFunding(null)).toBe(false);
  });
});

describe("isFallenOff (board fall-off predicate, ticket)", () => {
  it("FUNDED with every task done → true (fallen off)", () => {
    expect(isFallenOff({ stage: "FUNDED", tasksDone: 4, tasksTotal: 4 })).toBe(
      true,
    );
  });

  it("FUNDED with zero tasks → true (vacuously all done)", () => {
    expect(isFallenOff({ stage: "FUNDED", tasksDone: 0, tasksTotal: 0 })).toBe(
      true,
    );
  });

  it("FUNDED with an incomplete task → false (still on the board)", () => {
    expect(isFallenOff({ stage: "FUNDED", tasksDone: 3, tasksTotal: 4 })).toBe(
      false,
    );
    expect(isFallenOff({ stage: "FUNDED", tasksDone: 0, tasksTotal: 4 })).toBe(
      false,
    );
  });

  it("non-FUNDED stages never fall off, regardless of task counts", () => {
    expect(
      isFallenOff({ stage: "DECISION", tasksDone: 4, tasksTotal: 4 }),
    ).toBe(false);
    expect(
      isFallenOff({ stage: "DECISION", tasksDone: 0, tasksTotal: 0 }),
    ).toBe(false);
    expect(
      isFallenOff({ stage: "IN_TRANSFER", tasksDone: 4, tasksTotal: 4 }),
    ).toBe(false);
    expect(
      isFallenOff({ stage: "IN_TRANSFER", tasksDone: 0, tasksTotal: 0 }),
    ).toBe(false);
  });
});

describe("stage labels", () => {
  it("labels every stage (totality) with non-blank text", () => {
    for (const stage of TRANSFER_STAGES) {
      expect(STAGE_LABEL[stage]).toBeTruthy();
      expect(STAGE_LABEL[stage].trim()).not.toBe("");
      expect(stageLabel(stage)).toBe(STAGE_LABEL[stage]);
    }
  });

  it("has no stray keys beyond the three stages", () => {
    expect(Object.keys(STAGE_LABEL).sort()).toEqual(
      [...TRANSFER_STAGES].sort(),
    );
  });

  it("pins the display labels", () => {
    expect(stageLabel("DECISION")).toBe("Preparation");
    expect(stageLabel("IN_TRANSFER")).toBe("In transfer");
    expect(stageLabel("FUNDED")).toBe("Funded");
  });
});

describe("STAGE_GATES", () => {
  it("captions every stage (totality) with non-blank text", () => {
    expect(Object.keys(STAGE_GATES).sort()).toEqual(
      [...TRANSFER_STAGES].sort(),
    );
    for (const stage of TRANSFER_STAGES) {
      expect(STAGE_GATES[stage].trim()).not.toBe("");
    }
  });

  it("pins the collapsed gate captions (ticket Slice 1)", () => {
    expect(STAGE_GATES.DECISION).toBe(
      "Accounts open · funding plan · funding initiated",
    );
    expect(STAGE_GATES.IN_TRANSFER).toBe("ACAT in motion / cash in flight");
    expect(STAGE_GATES.FUNDED).toBe("Positions reconciled");
  });
});

describe("DEFAULT_TASKS", () => {
  it("gives every stage a non-empty checklist template", () => {
    expect(Object.keys(DEFAULT_TASKS).sort()).toEqual(
      [...TRANSFER_STAGES].sort(),
    );
    for (const stage of TRANSFER_STAGES) {
      expect(DEFAULT_TASKS[stage].length).toBeGreaterThan(0);
    }
  });

  it("has non-blank, de-duplicated titles within each stage", () => {
    for (const stage of TRANSFER_STAGES) {
      const titles = DEFAULT_TASKS[stage];
      for (const title of titles) {
        expect(title.trim()).not.toBe("");
      }
      expect(new Set(titles).size).toBe(titles.length);
    }
  });
});

describe("visibleTasks (DECISION checklist trim + partial-ACAT gate, owner 2026-07-20)", () => {
  // A DECISION transfer that already seeded the OLD 11-item template (an
  // existing row set) — visibleTasks must hide the removed + conditional titles.
  const legacyDecision = [
    "Collect statements",
    "Run asset mapper",
    "Resolve review items",
    "Advisor meeting scheduled",
    "Advisor meeting held",
    "Asset decisions made",
    "Send decision worksheet",
    "Asset decisions finalized",
    "Open receiving accounts",
    "Confirm account numbers",
    "Submit ACAT to Apex",
  ].map((title, i) => ({ title, done: false, sort_order: i }));

  const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

  it("hides the 5 removed titles on every DECISION transfer", () => {
    const out = titles(visibleTasks("DECISION", legacyDecision, "ACAT_FULL"));
    for (const gone of [
      "Resolve review items",
      "Advisor meeting scheduled",
      "Advisor meeting held",
      "Asset decisions made",
      "Submit ACAT to Apex",
    ]) {
      expect(out).not.toContain(gone);
    }
  });

  it("non-partial funding hides the two decision-worksheet items", () => {
    for (const ft of ["ACAT_FULL", null] as const) {
      const out = titles(visibleTasks("DECISION", legacyDecision, ft));
      expect(out).toEqual([
        "Collect statements",
        "Run asset mapper",
        "Open receiving accounts",
        "Confirm account numbers",
      ]);
    }
  });

  it("ACAT_PARTIAL shows the two decision-worksheet items", () => {
    const out = titles(visibleTasks("DECISION", legacyDecision, "ACAT_PARTIAL"));
    expect(out).toEqual([
      "Collect statements",
      "Run asset mapper",
      "Send decision worksheet",
      "Asset decisions finalized",
      "Open receiving accounts",
      "Confirm account numbers",
    ]);
  });

  it("preserves order and does not mutate the input", () => {
    const before = titles(legacyDecision);
    const out = visibleTasks("DECISION", legacyDecision, "ACAT_PARTIAL");
    // Input array is unchanged in length AND content/order (not just length).
    expect(titles(legacyDecision)).toEqual(before);
    expect(legacyDecision).toHaveLength(11);
    // Output is a new array whose order matches the input's (filtered subset).
    const outTitles = titles(out);
    expect(out).not.toBe(legacyDecision);
    expect(outTitles).toEqual(before.filter((t) => outTitles.includes(t)));
  });

  it("passes non-DECISION stages through unchanged (no trim)", () => {
    const inTransfer = DEFAULT_TASKS.IN_TRANSFER.map((title, i) => ({
      title,
      sort_order: i,
    }));
    expect(titles(visibleTasks("IN_TRANSFER", inTransfer, null))).toEqual([
      ...DEFAULT_TASKS.IN_TRANSFER,
    ]);
    // even titles that collide with the DECISION denylist are kept off-DECISION
    const funded = [{ title: "Submit ACAT to Apex", sort_order: 0 }];
    expect(titles(visibleTasks("FUNDED", funded, null))).toEqual([
      "Submit ACAT to Apex",
    ]);
  });
});

describe("stageChecklistTasks (CHECKLIST_STAGE_GATE per-stage scoping)", () => {
  const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

  it("scopes an IN_TRANSFER transfer to ONLY its IN_TRANSFER titles — stale earlier-stage rows are excluded", () => {
    // A transfer that carries its old DECISION rows PLUS the seeded IN_TRANSFER set.
    const accumulated = [
      "Collect statements", // stale DECISION
      "Run asset mapper", // stale DECISION
      "Resolve review items", // stale hidden DECISION
      "ACAT submitted to Apex",
      "Transfer accepted by contra",
      "Positions settling",
      "Cost basis received",
    ].map((title, i) => ({ title, sort_order: i }));
    expect(titles(stageChecklistTasks("IN_TRANSFER", accumulated, null))).toEqual(
      [...DEFAULT_TASKS.IN_TRANSFER],
    );
  });

  it("on DECISION matches visibleTasks for clean data (non-partial hides the worksheet items)", () => {
    const clean = DEFAULT_TASKS.DECISION.map((title, i) => ({
      title,
      sort_order: i,
    }));
    expect(titles(stageChecklistTasks("DECISION", clean, null))).toEqual([
      "Collect statements",
      "Run asset mapper",
      "Open receiving accounts",
      "Confirm account numbers",
    ]);
    expect(titles(stageChecklistTasks("DECISION", clean, "ACAT_PARTIAL"))).toEqual(
      [...DEFAULT_TASKS.DECISION],
    );
  });

  it("excludes custom ad-hoc titles not in DEFAULT_TASKS (they are not part of the stage gate)", () => {
    const rows = [
      { title: "ACAT submitted to Apex", sort_order: 0 },
      { title: "Call the client twice", sort_order: 1 }, // custom
    ];
    expect(titles(stageChecklistTasks("IN_TRANSFER", rows, null))).toEqual([
      "ACAT submitted to Apex",
    ]);
  });

  it("does not mutate the input", () => {
    const rows = DEFAULT_TASKS.FUNDED.map((title, i) => ({ title, sort_order: i }));
    const len = rows.length;
    stageChecklistTasks("FUNDED", rows, null);
    expect(rows).toHaveLength(len);
  });

  it("INVARIANT: DEFAULT_TASKS titles are disjoint across stages (stage membership is title-based)", () => {
    // stageChecklistTasks keys stage membership on the title; if a title were
    // reused across stages it would surface (and gate) on both. Pin disjointness.
    const all = [
      ...DEFAULT_TASKS.DECISION,
      ...DEFAULT_TASKS.IN_TRANSFER,
      ...DEFAULT_TASKS.FUNDED,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("missingStageChecklistRows", () => {
  it("appends only missing destination-stage defaults after accumulated tasks", () => {
    const accumulated = [
      { title: "Collect statements", sort_order: 0 },
      { title: "ACAT submitted to Apex", sort_order: 5 },
      { title: "Cost basis verified", sort_order: 8 },
    ];

    const rows = missingStageChecklistRows("transfer-1", "FUNDED", accumulated);

    expect(rows).toEqual([
      {
        transfer_id: "transfer-1",
        title: "All positions received",
        sort_order: 9,
      },
      {
        transfer_id: "transfer-1",
        title: "Transition template applied",
        sort_order: 10,
      },
      {
        transfer_id: "transfer-1",
        title: "Fee reimbursement filed",
        sort_order: 11,
      },
    ]);
    expect(accumulated).toHaveLength(3);
  });

  it("is idempotent when the current-stage checklist is already complete", () => {
    const tasks = DEFAULT_TASKS.IN_TRANSFER.map((title, sort_order) => ({
      title,
      sort_order,
    }));
    expect(
      missingStageChecklistRows("transfer-1", "IN_TRANSFER", tasks),
    ).toEqual([]);
  });
});

describe("resolveTaskDone + SYNCED_TASK_DEAL_FLAG (deal-card mirror S2)", () => {
  const stmt = (over: Partial<{ done: boolean; override_done: boolean | null }> = {}) => ({
    title: STATEMENTS_TITLE,
    done: false,
    override_done: null as boolean | null,
    ...over,
  });

  it("maps the two synced titles to their deal flags", () => {
    expect(SYNCED_TASK_DEAL_FLAG[STATEMENTS_TITLE]).toBe("statements");
    expect(SYNCED_TASK_DEAL_FLAG[ASSET_MAPPER_TITLE]).toBe("asset_mapped");
    // a non-synced title has no mapping
    expect(SYNCED_TASK_DEAL_FLAG["Open receiving accounts"]).toBeUndefined();
  });

  it("synced + no override → FOLLOWS the deal flag", () => {
    expect(resolveTaskDone(stmt(), { statements: true, asset_mapped: false })).toBe(true);
    expect(resolveTaskDone(stmt(), { statements: false, asset_mapped: false })).toBe(false);
    // asset mapper mirrors asset_mapped
    const mapper = { title: ASSET_MAPPER_TITLE, done: false, override_done: null };
    expect(resolveTaskDone(mapper, { statements: false, asset_mapped: true })).toBe(true);
  });

  it("synced + override WINS over the deal flag (both directions)", () => {
    expect(resolveTaskDone(stmt({ override_done: false }), { statements: true, asset_mapped: true })).toBe(false);
    expect(resolveTaskDone(stmt({ override_done: true }), { statements: false, asset_mapped: false })).toBe(true);
  });

  it("synced + no linked deal → falls back to the task's own done", () => {
    expect(resolveTaskDone(stmt({ done: true }), null)).toBe(true);
    expect(resolveTaskDone(stmt({ done: false }), null)).toBe(false);
    // override still wins even with no deal
    expect(resolveTaskDone(stmt({ done: false, override_done: true }), null)).toBe(true);
  });

  it("non-synced title → returns done, ignoring dealFlags/override_done", () => {
    const normal = { title: "Open receiving accounts", done: true, override_done: false };
    expect(resolveTaskDone(normal, { statements: false, asset_mapped: false })).toBe(true);
    expect(resolveTaskDone({ ...normal, done: false }, null)).toBe(false);
  });
});

describe("resolveTransferValue (deal owns the amount — live mirror)", () => {
  it("a linked deal's amount wins over the transfer's stored value", () => {
    expect(resolveTransferValue(1000, 7500)).toBe(7500);
  });

  it("no linked deal (null/undefined amount) → the transfer's own value", () => {
    expect(resolveTransferValue(1000, null)).toBe(1000);
    expect(resolveTransferValue(1000, undefined)).toBe(1000);
  });

  it("a real $0 deal amount wins (0 is a value, not 'absent')", () => {
    expect(resolveTransferValue(1000, 0)).toBe(0);
  });
});

describe("fundingSummary (card one-line funding meta, ticket)", () => {
  it("joins account type and contra with a bullet when both present", () => {
    expect(
      fundingSummary({
        asset_map_account_type: "Roth IRA",
        transferring_firm: "Fidelity",
      }),
    ).toBe("Roth IRA • Fidelity");
  });

  it("shows only the account type when the contra is absent", () => {
    expect(
      fundingSummary({
        asset_map_account_type: "Roth IRA",
        transferring_firm: null,
      }),
    ).toBe("Roth IRA");
  });

  it("shows only the contra when the account type is absent", () => {
    expect(
      fundingSummary({
        asset_map_account_type: null,
        transferring_firm: "Fidelity",
      }),
    ).toBe("Fidelity");
  });

  it("returns null when neither part exists (e.g. cash funding)", () => {
    expect(
      fundingSummary({
        asset_map_account_type: null,
        transferring_firm: null,
      }),
    ).toBeNull();
  });

  it("returns null for whitespace-only parts (trimmed → never a bare dot)", () => {
    expect(
      fundingSummary({
        asset_map_account_type: "   ",
        transferring_firm: "\t",
      }),
    ).toBeNull();
  });
});

describe("compareByClientName (per-lane board sort, ticket)", () => {
  it("orders by last name", () => {
    expect(
      compareByClientName(
        { client_last_name: "Adams", client_first_name: "Zoe" },
        { client_last_name: "Baker", client_first_name: "Al" },
      ),
    ).toBeLessThan(0);
    expect(
      compareByClientName(
        { client_last_name: "Baker", client_first_name: "Al" },
        { client_last_name: "Adams", client_first_name: "Zoe" },
      ),
    ).toBeGreaterThan(0);
  });

  it("breaks a last-name tie on first name", () => {
    expect(
      compareByClientName(
        { client_last_name: "Smith", client_first_name: "Anna" },
        { client_last_name: "Smith", client_first_name: "Ben" },
      ),
    ).toBeLessThan(0);
  });

  it("returns 0 when both names are equal", () => {
    expect(
      compareByClientName(
        { client_last_name: "Smith", client_first_name: "Anna" },
        { client_last_name: "Smith", client_first_name: "Anna" },
      ),
    ).toBe(0);
  });
});

describe("matchesFocus (server board focus filter, ticket)", () => {
  const row = {
    client_first_name: "Ada",
    client_last_name: "Chen",
    household_name: "Chen Family",
    household_sf_id: "HH-001",
  };

  it("matches a household by its sf_id (exact)", () => {
    expect(matchesFocus(row, { household: "HH-001" })).toBe(true);
    expect(matchesFocus(row, { household: "HH-999" })).toBe(false);
  });

  it("matches a household by its name (exact) when the key is the name", () => {
    expect(matchesFocus(row, { household: "Chen Family" })).toBe(true);
    expect(matchesFocus(row, { household: "Chen" })).toBe(false);
  });

  it("q is a case-insensitive substring over client name + household name", () => {
    expect(matchesFocus(row, { q: "ada" })).toBe(true);
    expect(matchesFocus(row, { q: "CHEN" })).toBe(true); // client last + household
    expect(matchesFocus(row, { q: "family" })).toBe(true); // household name only
    expect(matchesFocus(row, { q: "zzz" })).toBe(false);
  });

  it("empty focus → true (no narrowing)", () => {
    expect(matchesFocus(row, {})).toBe(true);
    expect(matchesFocus(row, { household: null, q: null })).toBe(true);
    expect(matchesFocus(row, { q: "   " })).toBe(true); // blank/whitespace q
  });

  it("household takes precedence over q when both are set", () => {
    // household present but non-matching → false even though q would match
    expect(matchesFocus(row, { household: "HH-999", q: "ada" })).toBe(false);
  });

  it("tolerates a null household_name when matching q", () => {
    const solo = { ...row, household_name: null, household_sf_id: null };
    expect(matchesFocus(solo, { q: "chen" })).toBe(true); // client name still matches
    expect(matchesFocus(solo, { q: "family" })).toBe(false); // no household to match
  });
});

describe("buildSearchGroups (grouped dropdown, ticket)", () => {
  const rows: SearchRow[] = [
    {
      id: "t1",
      name: "Daniel Chen",
      household: "Chen Family",
      householdKey: "HH-001",
      stage: "DECISION",
      value: 1000,
      contra: "Fidelity",
    },
    {
      id: "t2",
      name: "Bridgette Chen",
      household: "Chen Family",
      householdKey: "HH-001",
      stage: "FUNDED",
      value: 2500,
      contra: null,
    },
    {
      id: "t3",
      name: "Grace Hopper",
      household: null,
      householdKey: null,
      stage: "IN_TRANSFER",
      value: 500,
      contra: "Schwab",
    },
  ];

  it("dedupes households by key with a running count + total", () => {
    const groups = buildSearchGroups(rows, "chen");
    expect(groups.households).toHaveLength(1);
    expect(groups.households[0]).toEqual({
      key: "HH-001",
      name: "Chen Family",
      count: 2,
      total: 3500,
    });
  });

  it("lists every matching row as an individual (per transfer, with stage/value/contra)", () => {
    const groups = buildSearchGroups(rows, "chen");
    expect(groups.individuals).toEqual([
      {
        id: "t1",
        name: "Daniel Chen",
        stage: "DECISION",
        value: 1000,
        contra: "Fidelity",
      },
      {
        id: "t2",
        name: "Bridgette Chen",
        stage: "FUNDED",
        value: 2500,
        contra: null,
      },
    ]);
  });

  it("query filters both groups (client name OR household name, case-insensitive)", () => {
    const groups = buildSearchGroups(rows, "hopper");
    expect(groups.households).toEqual([]); // Grace has no household
    expect(groups.individuals).toHaveLength(1);
    expect(groups.individuals[0].id).toBe("t3");
  });

  it("skips rows with no household from the Households group but keeps them as individuals", () => {
    const groups = buildSearchGroups(rows, "grace");
    expect(groups.households).toEqual([]);
    expect(groups.individuals).toHaveLength(1);
  });

  it("empty/blank query → empty groups", () => {
    expect(buildSearchGroups(rows, "")).toEqual({
      households: [],
      individuals: [],
    });
    expect(buildSearchGroups(rows, "   ")).toEqual({
      households: [],
      individuals: [],
    });
  });

  it("keeps a client with a household key but null household name out of Households, as an individual", () => {
    const noName: SearchRow[] = [
      { id: "x1", name: "Abbey Bashirian", household: null, householdKey: "HH-9", stage: "DECISION", value: 100, contra: null },
    ];
    const groups = buildSearchGroups(noName, "abbey");
    expect(groups.households).toEqual([]);
    expect(groups.individuals).toHaveLength(1);
    expect(groups.individuals[0].id).toBe("x1");
  });

  it("first-seen household name wins when two rows share a key with differing names", () => {
    const dupe: SearchRow[] = [
      { id: "a", name: "Al Alpha", household: "Alpha Household", householdKey: "HH-7", stage: "DECISION", value: 100, contra: null },
      { id: "b", name: "Al Beta", household: "Alpha HH (alt)", householdKey: "HH-7", stage: "FUNDED", value: 200, contra: null },
    ];
    const groups = buildSearchGroups(dupe, "al");
    expect(groups.households).toHaveLength(1);
    expect(groups.households[0]).toEqual({ key: "HH-7", name: "Alpha Household", count: 2, total: 300 });
  });
});
