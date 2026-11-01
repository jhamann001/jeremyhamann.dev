import { describe, expect, it } from "vitest";
import type { MacroVars } from "@/types/domain";
import { macroVarsFor, renderMacroTemplate } from "@/lib/macro-template";

const VARS: MacroVars = {
  ticket: { number: "HD-1042" },
  requester: { name: "Pat Doe", firstName: "Pat" },
  agent: { name: "Olivia Ops" },
  today: "September 16, 2026",
};

describe("renderMacroTemplate", () => {
  it("replaces all five placeholders", () => {
    const body =
      "Re {{ticket.number}}: Hi {{requester.firstName}} ({{requester.name}}), from {{agent.name}} on {{today}}.";
    expect(renderMacroTemplate(body, VARS)).toBe(
      "Re HD-1042: Hi Pat (Pat Doe), from Olivia Ops on September 16, 2026.",
    );
  });

  it("leaves unknown placeholders verbatim", () => {
    const body = "{{ticket.number}} {{ticket.subject}} {{client.ssn}} {{unknown}} {{ticket}}";
    expect(renderMacroTemplate(body, VARS)).toBe("HD-1042 {{ticket.subject}} {{client.ssn}} {{unknown}} {{ticket}}");
  });

  it("tolerates inner whitespace and repeated placeholders", () => {
    expect(renderMacroTemplate("{{ today }} / {{today}} / {{  ticket.number  }}", VARS)).toBe(
      "September 16, 2026 / September 16, 2026 / HD-1042",
    );
  });

  it("leaves malformed braces and plain text untouched", () => {
    const body = "{ticket.number} {{{ticket.number}}} {{ticket.number";
    expect(renderMacroTemplate(body, VARS)).toBe("{ticket.number} {HD-1042} {{ticket.number");
    expect(renderMacroTemplate("no placeholders here", VARS)).toBe("no placeholders here");
    expect(renderMacroTemplate("", VARS)).toBe("");
  });

  it("does not treat prototype keys as placeholders", () => {
    expect(renderMacroTemplate("{{constructor}} {{toString}}", VARS)).toBe("{{constructor}} {{toString}}");
  });
});

describe("macroVarsFor", () => {
  // Local noon: the calendar date is the same in every timezone offset within ±11h.
  const today = new Date(2026, 8, 16, 12, 0, 0);

  it("formats the ticket number, derives firstName from the first whitespace token, formats today", () => {
    expect(macroVarsFor({ number: 1042, requesterName: "Pat Doe" }, "Olivia Ops", today)).toEqual(VARS);
  });

  it("firstName is the first token even with extra whitespace or a single name", () => {
    expect(macroVarsFor({ number: 7, requesterName: "  Mary   Ann Smith " }, "A", today).requester).toEqual({
      name: "Mary   Ann Smith",
      firstName: "Mary",
    });
    expect(macroVarsFor({ number: 7, requesterName: "Cher" }, "A", today).requester.firstName).toBe("Cher");
    expect(macroVarsFor({ number: 7, requesterName: "" }, "A", today).requester).toEqual({ name: "", firstName: "" });
  });

  it("renders an agent without a display name as an empty string", () => {
    expect(macroVarsFor({ number: 1, requesterName: "Pat" }, null, today).agent.name).toBe("");
    expect(macroVarsFor({ number: 1, requesterName: "Pat" }, "  Sam  ", today).agent.name).toBe("Sam");
  });

  it("formats other dates in the same long form", () => {
    expect(macroVarsFor({ number: 1, requesterName: "Pat" }, null, new Date(2027, 0, 3, 12)).today).toBe(
      "January 3, 2027",
    );
  });
});
