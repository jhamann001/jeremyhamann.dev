/**
 * Pure tests for the macro-admin inputs and the two rules the actions enforce before they touch the
 * database. The transactional behaviour — the audit rows, the
 * create-if-missing collision, the conditional retire — is proven in
 * `macros.actions.integration.test.ts`.
 *
 * The placeholder check is the one worth the most care: it is the last thing standing between a typo
 * in a template and `{{requester.emial}}` arriving in a client's inbox.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { MacroAdminInput, SetMacroActiveInput, UpdateMacroInput } from "@/types/domain";
import { AUDIT_VALUE_MAX_CHARS, prepareAuditMetadata, prepareAuditValue } from "@/lib/audit";
import { renderMacroTemplate } from "@/lib/macro-template";
import { sanitizePII } from "@/lib/pii";
import {
  MACRO_BODY_MAX,
  MACRO_PREVIEW_AGENT,
  MACRO_PREVIEW_DATE,
  MACRO_PREVIEW_TICKET,
  isMacroKey,
  macroAdminSchema,
  macroChannelDisclaimerError,
  setMacroActiveSchema,
  unknownPlaceholders,
  updateMacroSchema,
} from "@/server/macros";

const VALID: MacroAdminInput = {
  key: "wire-verification-notice",
  title: "Wire verification notice",
  queueKey: "OPERATIONS",
  body: "Hello {{requester.firstName}}, about {{ticket.number}}.",
  channel: "PUBLIC",
  disclaimerKey: "WIRE_VERIFICATION",
  sortOrder: 10,
};

describe("macroAdminSchema", () => {
  it("its output is exactly MacroAdminInput", () => {
    expectTypeOf<typeof macroAdminSchema._zod.output>().toEqualTypeOf<MacroAdminInput>();
  });

  it("accepts a well-formed macro and a global (queue-less) one", () => {
    expect(macroAdminSchema.parse(VALID)).toEqual(VALID);
    expect(macroAdminSchema.parse({ ...VALID, queueKey: null }).queueKey).toBeNull();
  });

  it("trims the title and body so a trailing newline is not a change", () => {
    const parsed = macroAdminSchema.parse({ ...VALID, title: "  Wire  ", body: "  hi  \n" });
    expect(parsed.title).toBe("Wire");
    expect(parsed.body).toBe("hi");
  });

  it("refuses a key that is not lower-case kebab", () => {
    for (const key of ["", "Wire-Notice", "wire notice", "wire_notice", "-wire", "wire-", "wire--notice", "a".repeat(65)]) {
      expect(() => macroAdminSchema.parse({ ...VALID, key }), key).toThrow();
    }
  });

  it("accepts the key shapes the seed file already uses", () => {
    for (const key of ["wire-verification-notice", "1099-availability", "tlh-explainer", "a"]) {
      expect(isMacroKey(key), key).toBe(true);
    }
  });

  it("refuses an empty title or body, and a body past the 20 000-character cap", () => {
    expect(() => macroAdminSchema.parse({ ...VALID, title: "   " })).toThrow();
    expect(() => macroAdminSchema.parse({ ...VALID, body: "" })).toThrow();
    expect(() => macroAdminSchema.parse({ ...VALID, body: "x".repeat(20_001) })).toThrow();
  });

  it("refuses an unknown queue, channel or disclaimer rather than coercing it", () => {
    expect(() => macroAdminSchema.parse({ ...VALID, queueKey: "COMPLIANCE" })).toThrow();
    expect(() => macroAdminSchema.parse({ ...VALID, channel: "PRIVATE" })).toThrow();
    expect(() => macroAdminSchema.parse({ ...VALID, disclaimerKey: "MADE_UP" })).toThrow();
  });

  it("refuses a negative or fractional sortOrder", () => {
    expect(() => macroAdminSchema.parse({ ...VALID, sortOrder: -1 })).toThrow();
    expect(() => macroAdminSchema.parse({ ...VALID, sortOrder: 1.5 })).toThrow();
  });
});

describe("updateMacroSchema", () => {
  it("its output is exactly UpdateMacroInput", () => {
    expectTypeOf<typeof updateMacroSchema._zod.output>().toEqualTypeOf<UpdateMacroInput>();
  });

  it("accepts the id alone — every field is optional, and undefined means 'not submitted'", () => {
    expect(updateMacroSchema.parse({ macroId: "ckabc123" })).toEqual({ macroId: "ckabc123" });
  });

  it("accepts a single-field patch and a queue being cleared to null", () => {
    expect(updateMacroSchema.parse({ macroId: "m1", sortOrder: 40 })).toEqual({ macroId: "m1", sortOrder: 40 });
    expect(updateMacroSchema.parse({ macroId: "m1", queueKey: null })).toEqual({ macroId: "m1", queueKey: null });
  });

  it("has no `key`: a macro's key is immutable once created", () => {
    const parsed = updateMacroSchema.parse({ macroId: "m1", key: "renamed" } as UpdateMacroInput) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("key");
  });

  it("refuses an id shape that is not a cuid / seed-style token", () => {
    for (const macroId of ["", " ", "with space", "a".repeat(65), "../../etc/passwd"]) {
      expect(() => updateMacroSchema.parse({ macroId }), macroId).toThrow();
    }
  });
});

describe("setMacroActiveSchema", () => {
  it("its output is exactly SetMacroActiveInput", () => {
    expectTypeOf<typeof setMacroActiveSchema._zod.output>().toEqualTypeOf<SetMacroActiveInput>();
  });

  it("accepts both directions and refuses a missing flag", () => {
    expect(setMacroActiveSchema.parse({ macroId: "m1", isActive: false })).toEqual({ macroId: "m1", isActive: false });
    expect(setMacroActiveSchema.parse({ macroId: "m1", isActive: true })).toEqual({ macroId: "m1", isActive: true });
    expect(() => setMacroActiveSchema.parse({ macroId: "m1" })).toThrow();
  });
});

describe("unknownPlaceholders", () => {
  it("passes a body built only from the five the renderer resolves", () => {
    expect(
      unknownPlaceholders(
        "{{ticket.number}} {{requester.name}} {{requester.firstName}} {{agent.name}} {{today}}",
      ),
    ).toEqual([]);
  });

  it("accepts the inner whitespace the renderer tolerates", () => {
    expect(unknownPlaceholders("{{ ticket.number }}")).toEqual([]);
  });

  it("catches a typo, a legacy help desk leftover and an empty placeholder", () => {
    expect(unknownPlaceholders("{{requester.emial}}")).toEqual(["{{requester.emial}}"]);
    expect(unknownPlaceholders("{{ticket.requester.first_name}}")).toEqual(["{{ticket.requester.first_name}}"]);
    expect(unknownPlaceholders("{{}}")).toEqual(["{{}}"]);
  });

  it("reports each distinct unknown once, however many times it appears", () => {
    expect(unknownPlaceholders("{{a.b}} {{a.b}} {{c.d}}")).toEqual(["{{a.b}}", "{{c.d}}"]);
  });

  it("agrees with the renderer: everything it reports is what the renderer would leave behind", () => {
    const body = "Hi {{requester.firstName}}, ref {{ticket.id}} on {{today}}.";
    const rendered = renderMacroTemplate(
      body,
      { ticket: { number: "HD-1" }, requester: { name: "A B", firstName: "A" }, agent: { name: "C" }, today: "d" },
    );
    for (const p of unknownPlaceholders(body)) expect(rendered).toContain(p);
  });

  it("is not confused by prose braces or a single brace", () => {
    expect(unknownPlaceholders("Use { and } freely, and {not a placeholder}.")).toEqual([]);
  });

  it("renders the preview constants without leaving anything unresolved", () => {
    const rendered = renderMacroTemplate(
      "{{ticket.number}} {{requester.name}} {{requester.firstName}} {{agent.name}} {{today}}",
      // The same three constants the server validates with, so a preview and a save agree.
      macroVars(),
    );
    expect(rendered).toContain("HD-1042");
    expect(rendered).toContain("Sample Client");
    expect(rendered).toContain("Sample Agent");
    expect(rendered).toContain("September 19, 2026");
  });
});

/** Built here rather than imported so the test states the expected preview values explicitly. */
function macroVars(): Parameters<typeof renderMacroTemplate>[1] {
  const name = MACRO_PREVIEW_TICKET.requesterName;
  return {
    ticket: { number: `HD-${MACRO_PREVIEW_TICKET.number}` },
    requester: { name, firstName: name.split(" ")[0] },
    agent: { name: MACRO_PREVIEW_AGENT },
    today: MACRO_PREVIEW_DATE.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

describe("macroChannelDisclaimerError", () => {
  it("refuses a public macro with no disclaimer — a public reply cannot be sent without one", () => {
    expect(macroChannelDisclaimerError("PUBLIC", "NONE")).toMatch(/must carry a disclaimer/);
  });

  it("refuses an internal macro that claims a disclaimer it cannot apply", () => {
    expect(macroChannelDisclaimerError("INTERNAL", "GENERAL_SERVICE")).toMatch(/must use the None disclaimer/);
  });

  it("accepts the two coherent pairs", () => {
    expect(macroChannelDisclaimerError("PUBLIC", "WIRE_VERIFICATION")).toBeNull();
    expect(macroChannelDisclaimerError("INTERNAL", "NONE")).toBeNull();
  });
});

/**
 * The reason `createMacro` / `updateMacro` put the full wording in `metadata` as well as in
 * `oldValue`/`newValue`: the two ceilings disagree by 5x, and the ledger is the only copy of
 * superseded client-facing wording. These are pure assertions about the audit mapper itself — the
 * end-to-end proof (a 20 000-character body read back out of a real AuditLog row byte-for-byte) is
 * in `macros.actions.integration.test.ts`.
 */
describe("the macro body's long-value channel", () => {
  const LONG_BODY = `Dear {{requester.firstName}},\n\n${"Firm-approved disclosure wording. ".repeat(500)}`.trimEnd();

  it("a body the schema accepts can be five times what an audit value column holds", () => {
    expect(MACRO_BODY_MAX).toBeGreaterThan(AUDIT_VALUE_MAX_CHARS);
    expect(LONG_BODY.length).toBeGreaterThan(AUDIT_VALUE_MAX_CHARS);
    expect(macroAdminSchema.parse({ ...VALID, body: LONG_BODY }).body).toBe(LONG_BODY);
  });

  it("prepareAuditValue truncates such a body — so the column alone cannot be the record", () => {
    const stored = prepareAuditValue(LONG_BODY);
    expect(stored).not.toBeNull();
    expect(stored).toHaveLength(AUDIT_VALUE_MAX_CHARS);
    expect(stored?.endsWith("…[truncated]")).toBe(true);
    expect(stored).not.toBe(LONG_BODY);
  });

  it("prepareAuditMetadata does not truncate, so metadata can carry both sides in full", () => {
    const prepared = prepareAuditMetadata({
      bodyFull: { previous: LONG_BODY, current: `${LONG_BODY}\n\nRevised.` },
    }) as { bodyFull: { previous: string; current: string } };
    expect(prepared.bodyFull.previous).toBe(LONG_BODY);
    expect(prepared.bodyFull.current).toBe(`${LONG_BODY}\n\nRevised.`);
  });

  it("the sample long body carries nothing the PII sanitizer would rewrite in metadata", () => {
    // A body that trips sanitizePII is refused outright by the actions, so the metadata copy of a
    // body that DID persist is always byte-identical. This pins the fixture to that assumption.
    expect(sanitizePII(LONG_BODY).redacted).toBe(false);
  });
});
