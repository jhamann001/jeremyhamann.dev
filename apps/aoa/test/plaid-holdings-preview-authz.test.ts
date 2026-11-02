import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { allowPlaidHoldingsPreviewEnabled } from "@/lib/flags";
import {
  canPreviewPlaidHoldings,
  plaidHoldingsPreviewAllowed,
} from "@/lib/auth/plaid-holdings-preview";

const ROLES = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER", "", null, undefined] as const;

function setSwitches(epic: string | undefined, preview: string | undefined, summaries?: string) {
  vi.stubEnv("EPIC_PLAID_LINKED_HOLDINGS", epic);
  vi.stubEnv("ALLOW_PLAID_HOLDINGS_PREVIEW", preview);
  vi.stubEnv("SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES", summaries);
}

afterEach(() => vi.unstubAllEnvs());

describe("canPreviewPlaidHoldings", () => {
  it.each([
    ["ADMIN", true],
    ["OPERATIONS", true],
    ["ADVISOR", false],
    ["CLIENT_SERVICE", false],
    ["VIEWER", false],
    ["admin", false],
    ["", false],
    [null, false],
    [undefined, false],
  ] as const)("role %s → %s", (role, allowed) => {
    expect(canPreviewPlaidHoldings(role)).toBe(allowed);
  });
});

describe("allowPlaidHoldingsPreviewEnabled", () => {
  it.each([
    [undefined, undefined, false],
    ["1", undefined, false],
    [undefined, "1", false],
    ["0", "1", false],
    ["1", "0", false],
    ["true", "1", false],
    ["1", "true", false],
    [" 1", "1", false],
    ["1", "1 ", false],
    ["1", "1", true],
  ])("epic=%j preview=%j → %s", (epic, preview, expected) => {
    setSwitches(epic, preview);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(expected);
  });

  it("is not turned on by the summaries switch", () => {
    setSwitches("1", undefined, "1");
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });
});

describe("plaidHoldingsPreviewAllowed (page and action gate)", () => {
  it.each(ROLES)("preview switch off hides the control for role %j", (role) => {
    setSwitches("1", undefined, "1");
    expect(plaidHoldingsPreviewAllowed(role)).toBe(false);
  });

  it.each(ROLES)("epic switch off hides the control for role %j", (role) => {
    setSwitches(undefined, "1", "1");
    expect(plaidHoldingsPreviewAllowed(role)).toBe(false);
  });

  it.each([
    ["ADMIN", true],
    ["OPERATIONS", true],
    ["ADVISOR", false],
    ["CLIENT_SERVICE", false],
    ["VIEWER", false],
    [null, false],
  ] as const)("both switches on: role %s → %s", (role, allowed) => {
    setSwitches("1", "1");
    expect(plaidHoldingsPreviewAllowed(role)).toBe(allowed);
  });
});
