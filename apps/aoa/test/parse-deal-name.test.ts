import { describe, it, expect } from "vitest";
import { parseDealName } from "@/lib/deals/parse-deal-name";

// The D4 deal-name parser pattern zoo (TDD ticket §7 step 1). Every name
// here is INVENTED (PII rule) — the convention is
// "<Client> - <Transferring Firm> - <Account Type> - <last4>".

describe("parseDealName — canonical full form", () => {
  it("parses the 4-segment convention with high confidence", () => {
    expect(parseDealName("Jordan Sample - Fidelity - Roth IRA - 1234")).toEqual({
      client_name: "Jordan Sample",
      transferring_firm: "Fidelity",
      account_type: "Roth IRA",
      account_last4: "1234",
      status_prefix: null,
      confidence: "high",
    });
  });

  it("handles multi-word firms and types", () => {
    const p = parseDealName("Riley Example - T. Rowe Price - 401(k) Rollover - 9042");
    expect(p.transferring_firm).toBe("T. Rowe Price");
    expect(p.account_type).toBe("401(k) Rollover");
    expect(p.account_last4).toBe("9042");
    expect(p.confidence).toBe("high");
  });

  it("keeps hyphenated tokens intact (splits on space-padded dashes only)", () => {
    const p = parseDealName("Casey Mock - Vanguard - SEP-IRA - 5527");
    expect(p.transferring_firm).toBe("Vanguard");
    expect(p.account_type).toBe("SEP-IRA");
    expect(p.account_last4).toBe("5527");
  });

  it("tolerates en/em dash separators", () => {
    const p = parseDealName("Drew Placeholder – Schwab – Joint – 2214");
    expect(p).toMatchObject({
      transferring_firm: "Schwab",
      account_type: "Joint",
      account_last4: "2214",
      confidence: "high",
    });
  });

  it("folds extra middle segments into the account type", () => {
    const p = parseDealName("Claire Kirlin - Empower - Inherited IRA - Spousal - 4470");
    expect(p.transferring_firm).toBe("Empower");
    expect(p.account_type).toBe("Inherited IRA - Spousal");
    expect(p.account_last4).toBe("4470");
  });
});

describe("parseDealName — status-prefix forms", () => {
  it("strips and captures a [Status] prefix", () => {
    const p = parseDealName(
      "[Pending Client Signature] Jordan Sample - Fidelity - Roth IRA - 1234",
    );
    expect(p.status_prefix).toBe("Pending Client Signature");
    expect(p.client_name).toBe("Jordan Sample");
    expect(p.transferring_firm).toBe("Fidelity");
    expect(p.account_type).toBe("Roth IRA");
    expect(p.account_last4).toBe("1234");
    expect(p.confidence).toBe("high");
  });

  it("handles a prefix on a partial name", () => {
    const p = parseDealName("[Awaiting ACAT] Abdullah Beahan - Betterment - Individual");
    expect(p.status_prefix).toBe("Awaiting ACAT");
    expect(p.transferring_firm).toBe("Betterment");
    expect(p.account_type).toBe("Individual");
    expect(p.account_last4).toBeNull();
    expect(p.confidence).toBe("partial");
  });
});

describe("parseDealName — $TBD forms", () => {
  it("treats a $TBD last4 slot as unknown (partial)", () => {
    const p = parseDealName("Casey Mock - Schwab - Roth IRA - $TBD");
    expect(p.transferring_firm).toBe("Schwab");
    expect(p.account_type).toBe("Roth IRA");
    expect(p.account_last4).toBeNull();
    expect(p.confidence).toBe("partial");
  });

  it("accepts bare TBD too", () => {
    const p = parseDealName("Casey Mock - Schwab - Roth IRA - TBD");
    expect(p.account_last4).toBeNull();
    expect(p.account_type).toBe("Roth IRA");
  });
});

describe("parseDealName — last4 variants", () => {
  it.each([
    ["#1234", "1234"],
    ["x1234", "1234"],
    ["*1234", "1234"],
    ["…1234", "1234"],
    ["...1234", "1234"],
  ])("extracts %s as %s", (decorated, digits) => {
    const p = parseDealName(`Abigale Beer - Pershing - Trust - ${decorated}`);
    expect(p.account_last4).toBe(digits);
    expect(p.confidence).toBe("high");
  });

  it("does not mistake a non-4-digit tail for a last4", () => {
    const p = parseDealName("Abigale Beer - Pershing - Trust - 123456");
    expect(p.account_last4).toBeNull();
    // "123456" is folded into the type per canonical ordering — flagged for
    // review by the non-high confidence? No: firm+type present, last4 absent.
    expect(p.confidence).toBe("partial");
  });
});

describe("parseDealName — missing segments", () => {
  it("3 segments without last4 → firm + type, partial", () => {
    const p = parseDealName("Drew Placeholder - Empower - 401(k) Rollover");
    expect(p).toMatchObject({
      client_name: "Drew Placeholder",
      transferring_firm: "Empower",
      account_type: "401(k) Rollover",
      account_last4: null,
      confidence: "partial",
    });
  });

  it("3 segments with last4 → lone middle classified as account type by keyword", () => {
    const p = parseDealName("Abdullah Beahan - Roth IRA - 4482");
    expect(p.transferring_firm).toBeNull();
    expect(p.account_type).toBe("Roth IRA");
    expect(p.account_last4).toBe("4482");
    expect(p.confidence).toBe("partial");
  });

  it("3 segments with last4 → lone non-keyword middle classified as firm", () => {
    const p = parseDealName("Abdullah Beahan - Fidelity - 4482");
    expect(p.transferring_firm).toBe("Fidelity");
    expect(p.account_type).toBeNull();
    expect(p.account_last4).toBe("4482");
    expect(p.confidence).toBe("partial");
  });

  it("2 segments → the single extra segment is classified", () => {
    expect(parseDealName("Abdullah Beahan - Fidelity").transferring_firm).toBe("Fidelity");
    expect(parseDealName("Abdullah Beahan - Joint").account_type).toBe("Joint");
    expect(parseDealName("Abdullah Beahan - 1234").account_last4).toBe("1234");
  });
});

describe("parseDealName — unparseable / degenerate", () => {
  it("a plain name with no separators extracts nothing (none)", () => {
    expect(parseDealName("Household consolidation")).toEqual({
      client_name: "Household consolidation",
      transferring_firm: null,
      account_type: null,
      account_last4: null,
      status_prefix: null,
      confidence: "none",
    });
  });

  it("unpadded dashes do not split (protects hyphenated names)", () => {
    const p = parseDealName("Jordan Sample-Fidelity-Roth IRA-1234");
    expect(p.confidence).toBe("none");
    expect(p.account_last4).toBeNull();
  });

  it("empty / null / whitespace input → all-null, none", () => {
    for (const v of ["", "   ", null, undefined]) {
      const p = parseDealName(v as string | null | undefined);
      expect(p.confidence).toBe("none");
      expect(p.client_name).toBeNull();
      expect(p.account_last4).toBeNull();
    }
  });

  it("a bare [Status] with nothing after it keeps the prefix only", () => {
    const p = parseDealName("[Pending Client Signature]");
    expect(p.status_prefix).toBe("Pending Client Signature");
    expect(p.client_name).toBeNull();
    expect(p.confidence).toBe("none");
  });
});
