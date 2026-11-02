import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { summaries } = vi.hoisted(() => ({ summaries: vi.fn() }));
vi.mock("@/lib/data/linked-external-account-summary", () => ({ linkedExternalSummariesForClient: summaries }));

import {
  linkedHoldingsAllowed,
  linkedHoldingsEnabled,
  loadLinkedAccounts,
  loadTransferLinkedAccounts,
  transferLast4,
} from "@/lib/data/transfer-linked-holdings";
import type { LinkedExternalAccountSummary } from "@/lib/data/linked-external-account-summary";

const OPS = { role: "OPERATIONS", email: "ops@example.test" };
const CLIENT = "003SYN000000001";
const FLAGS = ["ASSET_TRANSFER_WORKSPACE", "TRANSFER_PAPERWORK_RECORDS", "EPIC_PLAID_LINKED_HOLDINGS", "SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES", "ALLOW_PLAID_HOLDINGS_PREVIEW"];

function summary(over: Partial<LinkedExternalAccountSummary> = {}): LinkedExternalAccountSummary {
  return {
    externalAccountId: "ext-synthetic-1", clientSfId: CLIENT, householdSfId: "001SYN000000001", institutionName: "Fidelity",
    accountSubtype: "IRA", mask: "4821", cashAmount: 100, securitiesAmount: 3400, holdingsTotal: 3500, institutionBalance: 3500,
    asOf: new Date("2026-10-19T00:00:00Z"), linkStatus: "ACTIVE", lineageKey: null, priorExternalAccountId: null, ...over,
  } as LinkedExternalAccountSummary;
}

beforeEach(() => {
  for (const flag of FLAGS) vi.stubEnv(flag, "1");
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gates", () => {
  it("needs every workspace and Client Portrait switch, and an Admin/Operations role", () => {
    expect(linkedHoldingsEnabled()).toBe(true);
    expect(linkedHoldingsAllowed("OPERATIONS")).toBe(true);
    expect(linkedHoldingsAllowed("ADMIN")).toBe(true);
    expect(linkedHoldingsAllowed("ADVISOR")).toBe(false);
    expect(linkedHoldingsAllowed("CLIENT_SERVICE")).toBe(false);
    for (const flag of FLAGS) {
      vi.stubEnv(flag, "");
      expect(linkedHoldingsEnabled(), flag).toBe(false);
      expect(linkedHoldingsAllowed("OPERATIONS"), flag).toBe(false);
      vi.stubEnv(flag, "1");
    }
  });
});

describe("loadLinkedAccounts", () => {
  it("lists active accounts per client through the portrait reader and marks the transfer's source", async () => {
    const read = vi.fn(async () => [summary(), summary({ externalAccountId: "ext-2", mask: "9000", institutionName: null, accountSubtype: null }), summary({ externalAccountId: "ext-3", linkStatus: "REVOKED" })]);
    const accounts = await loadLinkedAccounts(OPS, [{ sfId: CLIENT, name: "Avery Stone", transferLast4s: ["4821"] }], read);
    expect(read).toHaveBeenCalledWith(OPS, CLIENT);
    expect(accounts).toEqual([
      { externalAccountId: "ext-synthetic-1", clientSfId: CLIENT, clientName: "Avery Stone", institution: "Fidelity", accountType: "IRA", mask: "4821", hasTransfer: true },
      { externalAccountId: "ext-2", clientSfId: CLIENT, clientName: "Avery Stone", institution: "Linked account", accountType: "Account", mask: "9000", hasTransfer: false },
    ]);
  });

  it("uses the deployed portrait summary reader by default", async () => {
    summaries.mockResolvedValue([summary()]);
    const result = await loadTransferLinkedAccounts(OPS, { client_sf_id: CLIENT, client_first_name: "Avery", client_last_name: "Stone", source_account_last4: "4821" });
    expect(summaries).toHaveBeenCalledWith(OPS, CLIENT);
    expect(result).toMatchObject({ last4: "4821", accounts: [{ externalAccountId: "ext-synthetic-1", clientName: "Avery Stone", hasTransfer: true }] });
  });

  it("reads nothing for a transfer without a client", async () => {
    expect(await loadTransferLinkedAccounts(OPS, { client_sf_id: null, client_first_name: "A", client_last_name: "B" })).toEqual({ accounts: [], last4: null });
    expect(summaries).not.toHaveBeenCalled();
  });

  it("uses the asset-map account suffix before the recorded last 4", () => {
    expect(transferLast4({ asset_map_account_number: "XLW-004821", source_account_last4: "1111" })).toBe("4821");
    expect(transferLast4({ asset_map_account_number: null, source_account_last4: "1111" })).toBe("1111");
  });
});

describe("read-only posture", () => {
  const files = [
    "lib/data/transfer-linked-holdings.ts",
    "lib/transfers/linked-holdings.ts",
    "components/asset-transfer/linked-holdings/LinkedHoldingsDialog.tsx",
    "components/asset-transfer/linked-holdings/TransferLinkedHoldings.tsx",
    "components/asset-transfer/linked-holdings/HouseholdLinkedHoldings.tsx",
  ];
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("never persists holdings or writes a transfer's asset map", () => {
    for (const path of files) {
      const source = read(path);
      expect(source, path).not.toMatch(/withUserScope|\$executeRaw|\$queryRaw|\.create\(|\.update\(|\.upsert\(|\.delete|transferDecision|writeAudit|prisma/);
    }
  });

  it("reads holdings only through the Client Portrait preview action", () => {
    expect(read("components/asset-transfer/linked-holdings/LinkedHoldingsDialog.tsx"))
      .toMatch(/import \{ previewLinkedHoldings \} from "@\/app\/\(authenticated\)\/client-portrait\/\[id\]\/actions";/);
    for (const path of files) expect(read(path), path).not.toMatch(/linked-external-holdings-preview|lib\/warehouse/);
  });
});
