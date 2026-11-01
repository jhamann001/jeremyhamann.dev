/**
 * S6 — activity-feed wording (docs/ARCHITECTURE.md §g S6 `ActivityRow`).
 *
 * `ActivityRow` itself is JSX and is NOT imported here: the frozen `vitest.config.ts` does not override
 * tsconfig's `jsx: "preserve"`, so vitest cannot load a file containing JSX syntax (the same reason
 * `markdown-renderer.tsx` is written with `createElement`). Every sentence the row renders comes from the
 * pure `activity-text.ts` helpers, which are pinned below; the JSX is a thin mapping of `FieldChange`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BRAND_LABELS,
  ESCALATION_TARGET_LABELS,
  SOURCE_LABELS,
  TICKET_BRANDS,
  TICKET_LINK_KINDS,
  TICKET_LINK_KIND_LABELS,
  TIMELINE_AUDIT_ACTIONS,
  ESCALATION_TARGETS,
} from "@/types/domain";
import { formatDateTime } from "@/lib/format";
import {
  ACTIVITY_VALUE_MAX_CHARS,
  FIELD_LABELS,
  describeFieldChange,
  describeIngest,
  displayValue,
  fieldChangeSentence,
  fieldLabel,
  macroActionsSentence,
} from "@/components/ticket/activity-text";

const ISO = "2026-09-16T23:21:00.000Z";
const ISO_EARLIER = "2026-09-16T20:00:00.000Z";

describe("FIELD_LABELS / fieldLabel", () => {
  it("maps every audited Ticket column to a human label (§e TICKET_FIELD_CHANGED list + status/priority/queue/assignee)", () => {
    expect(FIELD_LABELS).toMatchObject({
      firstRespondedAt: "first response",
      resolvedAt: "resolved at",
      closedAt: "closed at",
      slaFirstResponseMinutes: "first-response SLA (min)",
      slaResolutionMinutes: "resolution SLA (min)",
      firstResponseDueAt: "first response due",
      resolutionDueAt: "resolution due",
      clientReference: "client reference",
      subject: "subject",
      description: "description",
      category: "category",
      status: "status",
      priority: "priority",
      queueKey: "queue",
      assigneeId: "assignee",
      // Fix round 2: the ten Wave A columns, which used to fall through to the camel-case splitter.
      isComplaint: "complaint flag",
      complaintFiledAt: "complaint filed",
      escalationTarget: "escalation",
      followUpAt: "follow-up",
      externalRef: "external reference",
      requesterName: "requester name",
      requesterEmail: "requester email",
      requesterPhone: "requester phone",
      brand: "brand",
      householdId: "household",
      requesterExternalId: "client record id",
    });
    for (const [field, label] of Object.entries(FIELD_LABELS)) {
      expect(fieldLabel(field)).toBe(label);
      // Labels are lower-case prose; a camelCase column name never leaks through as its flattened form
      // ("firstrespondedat"). Single-word columns (status, subject, …) are their own label by design.
      expect(label).toMatch(/^[a-z][A-Za-z0-9 ()-]*$/); // "first-response SLA (min)" keeps its acronym
      if (/[A-Z]/.test(field)) expect(label).not.toBe(field.toLowerCase());
    }
  });

  it("falls back to a humanized form for unlisted fields and to 'a field' for null/blank", () => {
    expect(fieldLabel("someNewColumn")).toBe("some new column");
    expect(fieldLabel("SOME_ENUM_FIELD")).toBe("some enum field");
    expect(fieldLabel(null)).toBe("a field");
    expect(fieldLabel("   ")).toBe("a field");
  });
});

describe("displayValue", () => {
  it("returns null for empty values", () => {
    expect(displayValue("status", null)).toBeNull();
    expect(displayValue("status", "")).toBeNull();
  });

  it("labels enums, formats ISO timestamps and truncates long text", () => {
    expect(displayValue("status", "PENDING_CLIENT")).toBe("Pending client");
    expect(displayValue("priority", "URGENT")).toBe("Urgent");
    expect(displayValue("queueKey", "CLIENT_SERVICE")).toBe("Client Service");
    expect(displayValue("category", "WIRE_TRANSFER")).toBe("Wire transfer");
    expect(displayValue("firstRespondedAt", ISO)).toBe(formatDateTime(ISO));
    expect(displayValue("resolutionDueAt", ISO)).toBe(formatDateTime(ISO));
    expect(displayValue("slaFirstResponseMinutes", "30")).toBe("30");
    const long = "x".repeat(ACTIVITY_VALUE_MAX_CHARS + 5);
    expect(displayValue("description", long)).toBe(`${"x".repeat(ACTIVITY_VALUE_MAX_CHARS)}…`);
    expect(displayValue("subject", "short")).toBe("short");
  });
});

describe("describeFieldChange / fieldChangeSentence (F4 wording)", () => {
  it("empty → value reads 'set <field> to <value>'", () => {
    const change = describeFieldChange("firstRespondedAt", null, ISO);
    expect(change).toEqual({ kind: "set", field: "first response", to: formatDateTime(ISO) });
    expect(fieldChangeSentence(change)).toBe(`set first response to ${formatDateTime(ISO)}`);
  });

  it("value → value reads 'changed <field> <old> → <new>'", () => {
    const change = describeFieldChange("status", "NEW", "OPEN");
    expect(change).toEqual({ kind: "changed", field: "status", from: "New", to: "Open" });
    expect(fieldChangeSentence(change)).toBe("changed status New → Open");
    expect(fieldChangeSentence(describeFieldChange("slaFirstResponseMinutes", "30", "60"))).toBe(
      "changed first-response SLA (min) 30 → 60",
    );
    expect(fieldChangeSentence(describeFieldChange("resolutionDueAt", ISO_EARLIER, ISO))).toBe(
      `changed resolution due ${formatDateTime(ISO_EARLIER)} → ${formatDateTime(ISO)}`,
    );
  });

  it("value → empty reads 'cleared <field>' (reopen clears resolvedAt)", () => {
    const change = describeFieldChange("resolvedAt", ISO, null);
    expect(change).toEqual({ kind: "cleared", field: "resolved at", from: formatDateTime(ISO) });
    expect(fieldChangeSentence(change)).toBe("cleared resolved at");
    expect(fieldChangeSentence(describeFieldChange("clientReference", "Sato household", ""))).toBe("cleared client reference");
  });

  it("never emits a flattened camelCase column name or a bare dash placeholder", () => {
    for (const field of Object.keys(FIELD_LABELS)) {
      const sentence = fieldChangeSentence(describeFieldChange(field, null, "v"));
      if (/[A-Z]/.test(field)) expect(sentence).not.toContain(field.toLowerCase());
      expect(sentence).toMatch(/^set [a-z][A-Za-z0-9 ()-]* to [vV]$/); // category values are labelized ("V")
      expect(sentence).not.toContain("—");
    }
  });
});

describe("Wave A columns reach the timeline as prose, not as stored values (fix round 2)", () => {
  it("labels every escalation target", () => {
    for (const target of ESCALATION_TARGETS) {
      expect(displayValue("escalationTarget", target)).toBe(ESCALATION_TARGET_LABELS[target]);
    }
    expect(fieldChangeSentence(describeFieldChange("escalationTarget", "NONE", "COMPLIANCE"))).toBe(
      "changed escalation Not escalated → Compliance",
    );
  });

  it("labels every brand", () => {
    for (const brand of TICKET_BRANDS) expect(displayValue("brand", brand)).toBe(BRAND_LABELS[brand]);
    expect(fieldChangeSentence(describeFieldChange("brand", "CEDAR_RIDGE_WEALTH", "CEDAR_RIDGE_DIRECT"))).toBe(
      "changed brand Cedar Ridge Wealth → Cedar Ridge Direct",
    );
  });

  it("renders the complaint flag as Yes / No — never the stored boolean", () => {
    expect(displayValue("isComplaint", "true")).toBe("Yes");
    expect(displayValue("isComplaint", "false")).toBe("No");
    expect(fieldChangeSentence(describeFieldChange("isComplaint", "false", "true"))).toBe(
      "changed complaint flag No → Yes",
    );
  });

  it("does not turn free text that reads 'true' into a boolean", () => {
    expect(displayValue("subject", "true")).toBe("true");
    expect(displayValue("externalRef", "false")).toBe("false");
  });

  it("formats the Wave A timestamps and leaves the references verbatim", () => {
    expect(displayValue("complaintFiledAt", ISO)).toBe(formatDateTime(ISO));
    expect(displayValue("followUpAt", ISO)).toBe(formatDateTime(ISO));
    expect(fieldChangeSentence(describeFieldChange("externalRef", null, "ACAT-CTRL-889201"))).toBe(
      "set external reference to ACAT-CTRL-889201",
    );
    expect(fieldChangeSentence(describeFieldChange("requesterPhone", null, "+14155550123"))).toBe(
      "set requester phone to +14155550123",
    );
  });

  it("reproduces the three sentences observed on HD-6 / HD-36 in their fixed form", () => {
    expect(fieldChangeSentence(describeFieldChange("isComplaint", "false", "true"))).not.toContain("is complaint");
    expect(fieldChangeSentence(describeFieldChange("complaintFiledAt", null, ISO))).toBe(
      `set complaint filed to ${formatDateTime(ISO)}`,
    );
    expect(fieldChangeSentence(describeFieldChange("followUpAt", null, ISO))).toBe(
      `set follow-up to ${formatDateTime(ISO)}`,
    );
  });
});

describe("the F4 smoke-test row (TICKET_FIELD_CHANGED firstRespondedAt, — → ISO)", () => {
  it("reads 'set first response to <formatted time>' — no raw column name, no dash placeholder", () => {
    const sentence = fieldChangeSentence(describeFieldChange("firstRespondedAt", null, ISO));
    expect(sentence).toBe(`set first response to ${formatDateTime(ISO)}`);
    expect(sentence.toLowerCase()).not.toContain("firstrespondedat");
    expect(sentence).not.toContain("—");
    expect(sentence).not.toContain("→");
  });
});

/**
 * --- Fix round 2 ---
 *
 * Three Wave B rows bypassed this module's own rule ("raw column names never reach the UI") and printed
 * stored enum values and DB column names straight onto the chronology a compliance reviewer
 * reconstructs a merge or a macro-driven status change from.
 */
describe("link kind (TICKET_LINK_ADDED / TICKET_LINK_REMOVED)", () => {
  it("renders every kind as the label the links panel prints, never the enum", () => {
    for (const kind of TICKET_LINK_KINDS) {
      const shown = displayValue("kind", kind);
      expect(shown, kind).toBe(TICKET_LINK_KIND_LABELS[kind]);
      expect(shown, kind).not.toBe(kind);
    }
  });

  it("uses the OUTBOUND map, because linkEntry only ever writes on the from ticket", () => {
    // src/server/ticket-links.actions.ts writes one row, on `from` (or the merge loser). A timeline row
    // is therefore never the inbound end, where the panel would print "Has duplicate".
    expect(displayValue("kind", "DUPLICATE_OF")).toBe("Duplicate of");
    expect(displayValue("kind", "BLOCKS")).toBe("Blocks");
  });

  it("leaves a value it does not recognise alone rather than guessing", () => {
    expect(displayValue("kind", "SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
    expect(displayValue("kind", null)).toBeNull();
  });

  it("labels the column itself, for the generic field-change path", () => {
    expect(fieldLabel("kind")).toBe("link type");
  });
});

describe("macroActionsSentence", () => {
  // The literal strings src/server/macros-apply.ts pushes into `applied`.
  const APPLIED_NAMES = ["queueKey", "assignee", "priority", "resolution", "status", "followUpInDays", "escalationTarget"];

  it("prints no column name for any action a macro can apply", () => {
    const sentence = macroActionsSentence(APPLIED_NAMES.join(","));
    expect(sentence).not.toBeNull();
    for (const name of APPLIED_NAMES) {
      // "status" and "priority" ARE their own labels; the rest must not survive verbatim.
      if (name === "status" || name === "priority" || name === "resolution" || name === "assignee") continue;
      expect(sentence, name).not.toContain(name);
    }
    expect(sentence).toContain("queue");
    expect(sentence).toContain("follow-up");
    expect(sentence).toContain("escalation");
  });

  it("is the row the reviewer reads: the exact defect, gone", () => {
    expect(macroActionsSentence("queueKey,status,followUpInDays")).toBe("queue, status, follow-up");
  });

  it("returns null for nothing to say, so the caller can fall back", () => {
    expect(macroActionsSentence(null)).toBeNull();
    expect(macroActionsSentence("")).toBeNull();
    expect(macroActionsSentence(",, ,")).toBeNull();
  });

  it("degrades an unknown action to words, never to a column name", () => {
    expect(macroActionsSentence("someNewColumn")).toBe("some new column");
  });
});

describe("describeIngest (TICKET_INGESTED)", () => {
  const summary = (source: string): string =>
    JSON.stringify({ source, externalId: "call:phone:abc", category: "OTHER", priority: "NORMAL", queueKey: "CLIENT_SERVICE", brand: "WM" });

  it("says a person LOGGED a ticket they typed at the desk", () => {
    // B11 routes /tickets/new's Phone, Voicemail and In-person forms through the ingest core.
    for (const source of ["PHONE", "VOICEMAIL", "STAFF_FORM"]) {
      expect(describeIngest(summary(source)), source).toEqual({ verb: "logged this ticket", source: SOURCE_LABELS[source as keyof typeof SOURCE_LABELS] });
    }
  });

  it("says a channel DELIVERED a ticket it really delivered", () => {
    expect(describeIngest(summary("EMAIL"))).toEqual({ verb: "received this ticket", source: "Email" });
    expect(describeIngest(summary("CLIENT_APP"))).toEqual({ verb: "received this ticket", source: "Client app" });
  });

  it("never reads 'ticket ingested', which is what the default branch printed", () => {
    for (const source of Object.keys(SOURCE_LABELS)) {
      expect(describeIngest(summary(source)).verb).not.toContain("ingest");
    }
  });

  it("claims nothing when the stored summary is unreadable or unrecognised", () => {
    for (const bad of [null, "", "not json", "null", "[]", JSON.stringify({ source: 12 }), JSON.stringify({ source: "MADE_UP" })]) {
      expect(describeIngest(bad), String(bad)).toEqual({ verb: "received this ticket", source: null });
    }
  });
});

/**
 * `ActivityRow`'s `default` branch prints `labelize(action).toLowerCase()` — the enum with the
 * underscores taken out. That is how "ticket ingested" reached the feed, and how the link and macro
 * rows read before this pass. It is a deliberate fallback for a genuinely unknown action, not a home
 * for actions the timeline whitelist names, so the set that still lands there is PINNED: adding one to
 * `TIMELINE_AUDIT_ACTIONS` without deciding on a sentence fails here.
 */
describe("ActivityRow covers the timeline whitelist", () => {
  const ROW = readFileSync(fileURLToPath(new URL("./activity-row.tsx", import.meta.url)), "utf8");

  /** Actions with no `case` today, each one a conscious "the generic wording is good enough" call. */
  const ON_THE_GENERIC_FALLBACK = new Set([
    "TICKET_REOPENED_BY_REQUESTER",
    "TICKET_LINKED",
    "INTAKE_RELEASED",
    "CLIENT_CONTACT_RECORDED",
    "ATTACHMENT_ADDED",
    "ATTACHMENT_REMOVED",
    "SLA_ALERT",
  ]);

  it("has an explicit case for every timeline action that is not deliberately generic", () => {
    const missing = TIMELINE_AUDIT_ACTIONS.filter(
      (action) => !ON_THE_GENERIC_FALLBACK.has(action) && !ROW.includes(`case "${action}"`),
    );
    expect(missing, "timeline actions with no sentence in activity-row.tsx").toEqual([]);
  });

  it("keeps the pinned fallback set honest — every name in it is still a timeline action", () => {
    const stale = [...ON_THE_GENERIC_FALLBACK].filter((a) => !TIMELINE_AUDIT_ACTIONS.includes(a as never));
    expect(stale, "names pinned as generic that are no longer on the whitelist").toEqual([]);
  });

  it("proves the guard bites: TICKET_INGESTED is handled, not on the fallback list", () => {
    expect(ON_THE_GENERIC_FALLBACK.has("TICKET_INGESTED")).toBe(false);
    expect(ROW).toContain('case "TICKET_INGESTED"');
  });
});
