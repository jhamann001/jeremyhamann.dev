import { afterEach, describe, expect, it } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import { drawerContractEnabled, parseDrawerRequest } from "./acat-drawer-contract";

const EPIC = "EPIC_ACAT_TRANSFER_DRAWER";
const ROLLOUT = "ROLLOUT_ACAT_TRANSFER_DRAWER";

afterEach(() => {
  delete process.env[EPIC];
  delete process.env[ROLLOUT];
});

describe("drawer switches", () => {
  it("contract: flag is off when both switches are unset", () => {
    markCase("acat-drawer-contract", "flag is off when both switches are unset");
    expect(drawerContractEnabled()).toBe(false);
  });

  it("contract: flag is off when only the epic switch is 1", () => {
    markCase("acat-drawer-contract", "flag is off when only the epic switch is 1");
    process.env[EPIC] = "1";
    expect(drawerContractEnabled()).toBe(false);
  });

  it("contract: flag is off when only the rollout switch is 1", () => {
    markCase("acat-drawer-contract", "flag is off when only the rollout switch is 1");
    process.env[ROLLOUT] = "1";
    expect(drawerContractEnabled()).toBe(false);
  });

  it("contract: flag is off when a switch is not exactly 1", () => {
    markCase("acat-drawer-contract", "flag is off when a switch is not exactly 1");
    process.env[EPIC] = "1";
    process.env[ROLLOUT] = "true";
    expect(drawerContractEnabled()).toBe(false);
    process.env[ROLLOUT] = " 1";
    expect(drawerContractEnabled()).toBe(false);
  });

  it("contract: flag is on only when both switches equal 1", () => {
    markCase("acat-drawer-contract", "flag is on only when both switches equal 1");
    process.env[EPIC] = "1";
    process.env[ROLLOUT] = "1";
    expect(drawerContractEnabled()).toBe(true);
  });
});

describe("drawer requests", () => {
  it("contract: accepts one named change with an optional identity version", () => {
    markCase("acat-drawer-contract", "accepts one named change with an optional identity version");
    expect(parseDrawerRequest({ action: "change", field: "wealthAdvisor", value: " Dana Advisor " })).toEqual({
      ok: true,
      request: { action: "change", patch: { wealthAdvisor: "Dana Advisor" } },
    });
    expect(parseDrawerRequest({ action: "change", field: "acatTransferId", value: "TR-9", expectedIdentityVersion: 4 })).toEqual({
      ok: true,
      request: { action: "change", patch: { acatTransferId: "TR-9", expectedIdentityVersion: 4 } },
    });
    expect(parseDrawerRequest({ action: "change", field: "residualMonitoringRequired", value: false })).toEqual({
      ok: true,
      request: { action: "change", patch: { residualMonitoringRequired: false } },
    });
    expect(parseDrawerRequest({ action: "change", field: "dtccNumber", value: "61" })).toMatchObject({ ok: true });
  });

  it("contract: refuses status, notes, fee fields, and multiple changes", () => {
    markCase("acat-drawer-contract", "refuses status, notes, fee fields, and multiple changes");
    for (const field of ["status", "notes", "feeAmount", "feeCharged", "tradeInstructions", "reconCompletedAt", "clientName"]) {
      expect(parseDrawerRequest({ action: "change", field, value: "x" }).ok).toBe(false);
    }
    expect(parseDrawerRequest({ action: "change", field: "wealthAdvisor", value: "A", extra: "B" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "change", changes: [{ field: "wealthAdvisor", value: "A" }, { field: "crwEe", value: "B" }] }).ok).toBe(false);
    expect(parseDrawerRequest({ wealthAdvisor: "A" }).ok).toBe(false);
    expect(parseDrawerRequest([{ action: "change" }]).ok).toBe(false);
    expect(parseDrawerRequest({ action: "reopen" }).ok).toBe(false);
  });

  it("contract: refuses blank and invalid change values", () => {
    markCase("acat-drawer-contract", "refuses blank and invalid change values");
    expect(parseDrawerRequest({ action: "change", field: "wealthAdvisor", value: "   " }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "change", field: "wealthAdvisor", value: null }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "change", field: "wealthAdvisor" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "change", field: "dtccNumber", value: "12345" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "change", field: "tradeRequestUrl", value: "not a url" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "change", field: "opsSubmissionDateToApex", value: "not a date" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "change", field: "statementAmount", value: "12" }).ok).toBe(false);
  });

  it("contract: complete requires a valid Apex completion date", () => {
    markCase("acat-drawer-contract", "complete requires a valid Apex completion date");
    expect(parseDrawerRequest({ action: "complete" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "complete", apexCompletionDate: "  " }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "complete", apexCompletionDate: "someday" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "complete", apexCompletionDate: "2026-10-12" })).toEqual({
      ok: true,
      request: { action: "complete", patch: { status: "Completed", apexCompletionDate: "2026-10-12" } },
    });
  });

  it("contract: complete control number is optional and blank clears it", () => {
    markCase("acat-drawer-contract", "complete control number is optional and blank clears it");
    expect(parseDrawerRequest({ action: "complete", apexCompletionDate: "2026-10-12", controlNumber: " CTRL-9 " })).toEqual({
      ok: true,
      request: { action: "complete", patch: { status: "Completed", apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9" } },
    });
    expect(parseDrawerRequest({ action: "complete", apexCompletionDate: "2026-10-12", controlNumber: "  " })).toEqual({
      ok: true,
      request: { action: "complete", patch: { status: "Completed", apexCompletionDate: "2026-10-12", controlNumber: null } },
    });
    expect(parseDrawerRequest({ action: "complete", apexCompletionDate: "2026-10-12", controlNumber: null })).toMatchObject({
      ok: true,
      request: { patch: { controlNumber: null } },
    });
  });

  it("contract: reject requires a nonblank trimmed reason", () => {
    markCase("acat-drawer-contract", "reject requires a nonblank trimmed reason");
    expect(parseDrawerRequest({ action: "reject", reason: "   " }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "reject" }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "reject", reason: " Wrong custodian " })).toEqual({
      ok: true,
      request: { action: "reject", patch: { status: "Rejected", rejectionReason: "Wrong custodian" } },
    });
  });

  it("contract: replaceClient takes the nested relink schema and refuses unknown keys", () => {
    markCase("acat-drawer-contract", "replaceClient takes the nested relink schema and refuses unknown keys");
    const relink = {
      cedarRidgeUserId: "user-11111111-1111-1111-1111-111111111111",
      expectedIdentityVersion: 3,
      reason: "Wrong person linked",
      replaceDisplayName: true,
    };
    const parsed = parseDrawerRequest({ action: "replaceClient", relink });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request.action === "replaceClient" && parsed.request.relink.expectedIdentityVersion).toBe(3);
    expect(parseDrawerRequest({ action: "replaceClient", ...relink }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "replaceClient", relink: { ...relink, injected: true } }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "replaceClient", relink: { ...relink, expectedIdentityVersion: undefined } }).ok).toBe(false);
    expect(parseDrawerRequest({ action: "replaceClient", relink, other: 1 }).ok).toBe(false);
  });
});
