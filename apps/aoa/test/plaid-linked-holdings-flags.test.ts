import { afterEach, describe, expect, it } from "vitest";
import {
  allowPlaidHoldingsPreviewEnabled,
  epicPlaidLinkedHoldingsEnabled,
  showPlaidLinkedAccountSummariesEnabled,
} from "@/lib/flags";

const KEYS = [
  "EPIC_PLAID_LINKED_HOLDINGS",
  "SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES",
  "ALLOW_PLAID_HOLDINGS_PREVIEW",
] as const;

type FlagKey = (typeof KEYS)[number];

function apply(values: Partial<Record<FlagKey, string>>) {
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("plaid linked-holdings three-switch matrix", () => {
  const saved: Partial<Record<FlagKey, string>> = {};
  for (const key of KEYS) saved[key] = process.env[key];

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("all unset keeps master and both surfaces off", () => {
    apply({});
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(false);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });

  it("master alone does not turn either surface on", () => {
    apply({ EPIC_PLAID_LINKED_HOLDINGS: "1" });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(true);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });

  it("summaries surface without master stays off", () => {
    apply({ SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES: "1" });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(false);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });

  it("preview surface without master stays off", () => {
    apply({ ALLOW_PLAID_HOLDINGS_PREVIEW: "1" });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(false);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });

  it("master plus summaries leaves preview off", () => {
    apply({
      EPIC_PLAID_LINKED_HOLDINGS: "1",
      SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES: "1",
    });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(true);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(true);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });

  it("master plus preview leaves summaries off", () => {
    apply({
      EPIC_PLAID_LINKED_HOLDINGS: "1",
      ALLOW_PLAID_HOLDINGS_PREVIEW: "1",
    });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(true);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(true);
  });

  it("master off turns both surfaces off even when surface vars are 1", () => {
    apply({
      SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES: "1",
      ALLOW_PLAID_HOLDINGS_PREVIEW: "1",
    });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(false);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });

  it("non-1 values including true stay off", () => {
    apply({
      EPIC_PLAID_LINKED_HOLDINGS: "true",
      SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES: "true",
      ALLOW_PLAID_HOLDINGS_PREVIEW: "true",
    });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(false);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(false);
  });

  it("all three exact 1 turns master and both surfaces on", () => {
    apply({
      EPIC_PLAID_LINKED_HOLDINGS: "1",
      SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES: "1",
      ALLOW_PLAID_HOLDINGS_PREVIEW: "1",
    });
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(true);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(true);
    expect(allowPlaidHoldingsPreviewEnabled()).toBe(true);
  });
});
