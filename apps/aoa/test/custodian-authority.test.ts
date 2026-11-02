import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));

import {
  confirmCustodianAuthorityRevision,
  listCustodianAuthorityRevisions,
  mergeCustodianAuthority,
  readCustodianAuthorityProfiles,
  saveCustodianAuthority,
} from "@/lib/data/custodian-authority";
import { custodianAuthorityStorageWritesEnabled } from "@/lib/flags";
import { withUserScope } from "@/lib/rls";
import { markCase } from "./acat-book-flywheel";

const ADMIN = { role: "ADMIN", email: "custodian-admin@example.test" };
const SAVE = { profile: { id: "tkt399-unit", name: "Synthetic Custodian" }, fees: [] };
const KEYS = ["ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399", "EPIC_ACAT_CUSTODIAN_ADMIN_TKT323", "SHOW_ACAT_CUSTODIAN_ADMIN_TKT337"];

function setAll(value: string | undefined): void {
  for (const key of KEYS) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("custodian authority write gates", () => {
  beforeEach(() => {
    vi.mocked(withUserScope).mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    setAll(undefined);
    vi.restoreAllMocks();
  });

  it("reads the storage switch as exact \"1\" only", () => {
    setAll(undefined);
    expect(custodianAuthorityStorageWritesEnabled()).toBe(false);
    process.env.ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399 = "true";
    expect(custodianAuthorityStorageWritesEnabled()).toBe(false);
    process.env.ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399 = "1";
    expect(custodianAuthorityStorageWritesEnabled()).toBe(true);
    markCase("custodian-authority", "reads the storage switch as exact \"1\" only");
  });

  it("refuses saves and merges while the storage switch is off, without opening a transaction", async () => {
    setAll(undefined);
    process.env.EPIC_ACAT_CUSTODIAN_ADMIN_TKT323 = "1";
    process.env.SHOW_ACAT_CUSTODIAN_ADMIN_TKT337 = "1";
    await expect(saveCustodianAuthority(ADMIN, SAVE)).resolves.toEqual({ ok: false, reason: "writes_disabled" });
    await expect(mergeCustodianAuthority(ADMIN, { sourceId: "a", targetId: "b" }))
      .resolves.toEqual({ ok: false, reason: "writes_disabled" });
    expect(withUserScope).not.toHaveBeenCalled();
    markCase("custodian-authority", "refuses saves and merges while the storage switch is off, without opening a transaction");
  });

  it("still requires the custodian administration switches", async () => {
    setAll(undefined);
    process.env.ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399 = "1";
    await expect(saveCustodianAuthority(ADMIN, SAVE)).resolves.toEqual({ ok: false, reason: "not_permitted" });
    expect(withUserScope).not.toHaveBeenCalled();
    markCase("custodian-authority", "still requires the custodian administration switches");
  });

  it("refuses every role except ADMIN", async () => {
    setAll("1");
    for (const role of ["OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER", null]) {
      await expect(saveCustodianAuthority({ role, email: "someone@example.test" }, SAVE))
        .resolves.toEqual({ ok: false, reason: "not_permitted" });
    }
    expect(withUserScope).not.toHaveBeenCalled();
    markCase("custodian-authority", "refuses every role except ADMIN");
  });

  it("refuses a merge of a custodian into itself", async () => {
    setAll("1");
    await expect(mergeCustodianAuthority(ADMIN, { sourceId: "same", targetId: "same" }))
      .resolves.toEqual({ ok: false, reason: "invalid_merge" });
    expect(withUserScope).not.toHaveBeenCalled();
    markCase("custodian-authority", "refuses a merge of a custodian into itself");
  });

  it("reports an unexpected transaction error as a save that did not complete", async () => {
    setAll("1");
    vi.stubEnv("TEST_RUN_ID", "run-399");
    vi.mocked(withUserScope).mockRejectedValue(new Error("connection reset"));
    await expect(saveCustodianAuthority(ADMIN, SAVE)).resolves.toEqual({ ok: false, reason: "save_failed" });
    const line = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(JSON.parse(line)).toEqual({
      feature: "custodian-authority", operation: "save", outcome: "save_failed", run_id: "run-399",
    });
    expect(line).not.toMatch(/example\.test|connection reset/i);
    await expect(mergeCustodianAuthority(ADMIN, { sourceId: "a", targetId: "b" }))
      .resolves.toEqual({ ok: false, reason: "merge_failed" });
    delete process.env.TEST_RUN_ID;
    markCase("custodian-authority", "reports an unexpected transaction error as a save that did not complete");
  });

  it("reads profiles for ADMIN and OPERATIONS while the write switch is off", async () => {
    setAll(undefined);
    vi.mocked(withUserScope).mockImplementation(async (_identity, fn) => fn({
      custodianProfile: { findMany: vi.fn().mockResolvedValue([]) },
    } as never));
    await expect(readCustodianAuthorityProfiles("ADMIN")).resolves.toEqual({ ok: true, value: [] });
    await expect(readCustodianAuthorityProfiles("OPERATIONS")).resolves.toEqual({ ok: true, value: [] });
    await expect(readCustodianAuthorityProfiles("VIEWER")).resolves.toEqual({ ok: false, reason: "not_permitted" });
    expect(withUserScope).toHaveBeenCalledTimes(2);
    expect(vi.mocked(withUserScope).mock.calls.map((call) => call[0])).toEqual([{ role: "ADMIN" }, { role: "OPERATIONS" }]);
    markCase("custodian-authority", "reads profiles for ADMIN and OPERATIONS while the write switch is off");
  });

  it("lists event payloads in revision order as revision and body", async () => {
    vi.mocked(withUserScope).mockImplementation(async (_identity, fn) => fn({
      custodianAuthorityEvent: {
        findMany: vi.fn().mockResolvedValue([
          { revision: BigInt(1), payload: { a: 1 } },
          { revision: BigInt(2), payload: { b: 1 } },
        ]),
      },
    } as never));
    await expect(listCustodianAuthorityRevisions()).resolves.toEqual([
      { revision: 1, body: { a: 1 } },
      { revision: 2, body: { b: 1 } },
    ]);
    markCase("custodian-authority", "lists event payloads in revision order as revision and body");
  });

  it("rejects a confirmation that is not a positive integer before opening a transaction", async () => {
    await expect(confirmCustodianAuthorityRevision(1.5)).rejects.toThrow("revision_not_accepted");
    await expect(confirmCustodianAuthorityRevision(0)).rejects.toThrow("revision_not_accepted");
    expect(withUserScope).not.toHaveBeenCalled();
    markCase("custodian-authority", "rejects a confirmation that is not a positive integer before opening a transaction");
  });

  it("confirms the same revision again without writing, and refuses a skip past the accepted revision", async () => {
    const update = vi.fn();
    const state = { accepted_revision: BigInt(2), confirmed_revision: BigInt(2) };
    vi.mocked(withUserScope).mockImplementation(async (_identity, fn) => fn({
      $queryRaw: vi.fn().mockImplementation(async () => [state]),
      custodianAuthorityEvent: { findUnique: vi.fn().mockResolvedValue({ revision: BigInt(3) }) },
      custodianAuthorityState: { update },
    } as never));

    await expect(confirmCustodianAuthorityRevision(2)).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();

    state.confirmed_revision = BigInt(1);
    await expect(confirmCustodianAuthorityRevision(3)).rejects.toThrow("revision_not_accepted");
    expect(update).not.toHaveBeenCalled();

    state.accepted_revision = BigInt(1);
    await expect(confirmCustodianAuthorityRevision(2)).rejects.toThrow("revision_not_accepted");
    expect(update).not.toHaveBeenCalled();

    state.accepted_revision = BigInt(2);
    state.confirmed_revision = BigInt(1);
    await expect(confirmCustodianAuthorityRevision(2)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith({ where: { id: 1 }, data: { confirmed_revision: BigInt(2) } });
    markCase("custodian-authority", "confirms the same revision again without writing, and refuses a skip past the accepted revision");
  });
});
