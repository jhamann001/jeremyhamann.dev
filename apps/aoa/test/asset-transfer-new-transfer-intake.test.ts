import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, withUserScopeSpy, redirectSpy, workspaceSpy, assetMapLinkSpy, connections } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  redirectSpy: vi.fn(),
  workspaceSpy: vi.fn(() => true),
  assetMapLinkSpy: vi.fn(() => false),
  connections: {
    readDirectoryClient: vi.fn(),
    readDealOptions: vi.fn(),
    readApexAccountRows: vi.fn(),
    readCustodianOption: vi.fn(),
    readAssetMapSourceFacts: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  assetTransferWorkspaceEnabled: workspaceSpy,
  assetMapTransferLinkEnabled: assetMapLinkSpy,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn(() => true) }));
vi.mock("@/lib/data/transfer-connections", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  ...connections,
}));

import { createTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { EMPTY_TRANSFER_FORM } from "@/components/transfers/transfer-form";
import {
  intakeAccountsFrom,
  overlappingTransfer,
  validateConnectedIntake,
  type ConnectedIntakeContext,
  type ConnectedIntakeInput,
  type IntakeTransferRow,
} from "@/lib/transfers/new-transfer-intake";
import { validateClientRequest } from "@/lib/transfers/client-request";

const INTAKE: ConnectedIntakeInput = {
  clientSfId: "SF-TEST-1", dealId: "", sourceMode: "pending", assetMapAccountId: "", sourceType: "",
  deliveringCustodianId: "", destinationMode: "new", apexAccountKey: "", destinationType: "Individual",
  destinationTitle: "Test Client", route: "paper_acat",
};

const CONTEXT: ConnectedIntakeContext = {
  clientName: "Test Client", deal: null, assetMap: null, apexReceiving: [], custodian: null,
};

const EXISTING_ROW: IntakeTransferRow = {
  transferId: "T-EXISTING", institution: "Sample Brokerage", type: "Roth IRA", last4: "1234", title: "Test Client",
  receivingType: "Roth IRA", receivingTitle: "Test Client", openAccounts: ["Cedar Ridge Roth IRA"], active: true,
};

const VALUES = {
  ...EMPTY_TRANSFER_FORM, client_first_name: "Typed", client_last_name: "Name", client_sf_id: "SF-TEST-1", value: "25000",
};

const DIRECTORY_CLIENT = {
  sfId: "SF-TEST-1", firstName: "Test", lastName: "Client", name: "Test Client", householdSfId: "HH-TEST-1", householdName: "Test Household",
};

const DEAL = {
  id: "deal-1", sfDealId: "SF-DEAL-1", name: "Synthetic rollover", amount: 40000, stage: "OPEN", clientSfId: "SF-TEST-1",
  accountLast4: "9312", transferringFirm: "Sample Deal Brokerage", linkedTransferId: null,
};

function wire(existing: Partial<Record<string, unknown>>[] = []) {
  const tx = {
    transfer: {
      findMany: vi.fn(async () => existing),
      create: vi.fn(async () => ({ id: "new-1", acat_link_version: 0 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  withUserScopeSpy.mockImplementation(async (_identity: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx));
  return tx;
}

function dbRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "T-EXISTING", stage: "IN_TRANSFER", transferring_firm: "Sample Brokerage", asset_map_account_type: null,
    asset_map_account_number: null, source_account_type: "Roth IRA", source_account_last4: "1234", source_account_title: "Test Client",
    receiving_account_type: "Roth IRA", receiving_account_title: "Test Client",
    accounts: [{ label: "Cedar Ridge Roth IRA" }], outcomes: [], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceSpy.mockReturnValue(true);
  authSpy.mockResolvedValue({ user: { email: "cs@example.test", role: "CLIENT_SERVICE" } });
  connections.readDirectoryClient.mockResolvedValue(DIRECTORY_CLIENT);
  connections.readDealOptions.mockResolvedValue([DEAL]);
  connections.readApexAccountRows.mockResolvedValue([]);
  connections.readCustodianOption.mockResolvedValue(null);
  connections.readAssetMapSourceFacts.mockResolvedValue(null);
});

describe("connected intake validation", () => {
  it("opens a pending source with a new receiving account", () => {
    expect(validateConnectedIntake(INTAKE, CONTEXT)).toEqual({ ok: true, value: {
      source: { institution: null, type: null, last4: null, title: null },
      custodianId: null,
      receiving: { type: "Individual", title: "Test Client", label: "Individual · Test Client", open: false },
      fundingType: "ACAT_FULL",
    } });
  });

  it("takes the source from the asset map or the deal, never typed", () => {
    const assetMap = { institution: "Sample Map Custodian", type: "Roth IRA", last4: "7788", title: "Test Client" };
    const fromMap = validateConnectedIntake({ ...INTAKE, sourceMode: "asset_map", assetMapAccountId: "acct-1" }, { ...CONTEXT, assetMap });
    expect(fromMap.ok && fromMap.value.source).toEqual(assetMap);
    const fromDeal = validateConnectedIntake({ ...INTAKE, sourceMode: "deal", sourceType: "Traditional IRA" },
      { ...CONTEXT, deal: { accountLast4: "xx-5566", transferringFirm: "Sample Deal Brokerage" } });
    expect(fromDeal.ok && fromDeal.value.source).toEqual({ institution: "Sample Deal Brokerage", type: "Traditional IRA", last4: "5566", title: "Test Client" });
    const { sources } = intakeAccountsFrom([EXISTING_ROW, { ...EXISTING_ROW, transferId: "T-DUP" }]);
    expect(sources).toHaveLength(1);
    const earlier = validateConnectedIntake({ ...INTAKE, sourceMode: "existing" }, CONTEXT);
    expect(earlier.ok ? [] : earlier.errors.map(error => error.field)).toEqual(["sourceMode"]);
  });

  it("refuses unresolved ids and unknown modes", () => {
    const fields = (input: Partial<ConnectedIntakeInput>, context: Partial<ConnectedIntakeContext> = {}) => {
      const result = validateConnectedIntake({ ...INTAKE, ...input }, { ...CONTEXT, ...context });
      return result.ok ? [] : result.errors.map(error => error.field).sort();
    };
    expect(fields({ sourceMode: "asset_map", assetMapAccountId: "forged" })).toEqual(["assetMapAccountId"]);
    expect(fields({ sourceMode: "deal", sourceType: "Individual" })).toEqual(["dealId"]);
    expect(fields({ sourceMode: "typed" })).toEqual(["sourceMode"]);
    expect(fields({ deliveringCustodianId: "cust-forged" })).toEqual(["deliveringCustodianId"]);
    expect(fields({ destinationMode: "apex", apexAccountKey: "roth|••••0000" })).toEqual(["apexAccountKey"]);
    expect(fields({ route: "carrier_pigeon", destinationType: "Bank account" })).toEqual(["destinationType", "route"]);
  });

  it("uses an open Apex account and the custodian profile's name", () => {
    const result = validateConnectedIntake(
      { ...INTAKE, sourceMode: "deal", sourceType: "Roth IRA", destinationMode: "apex", apexAccountKey: "ira|••••6252", deliveringCustodianId: "cust-1" },
      { ...CONTEXT, deal: { accountLast4: "1234", transferringFirm: "Sample Brokerage" },
        apexReceiving: [{ key: "ira|••••6252", type: "Roth IRA", masked: "••••6252" }], custodian: { id: "cust-1", name: "Sample Library Custodian" } },
    );
    expect(result.ok && result.value).toMatchObject({
      source: { institution: "Sample Library Custodian", last4: "1234" },
      custodianId: "cust-1",
      receiving: { label: "Roth IRA · Apex ••••6252", open: true },
    });
  });

  it("finds an active transfer already moving the source", () => {
    const source = { institution: "sample brokerage", type: "Roth IRA", last4: "1234", title: "" };
    expect(overlappingTransfer([EXISTING_ROW], source)).toBe("T-EXISTING");
    expect(overlappingTransfer([{ ...EXISTING_ROW, active: false }], source)).toBeNull();
  });

  it("validates the client request date and source", () => {
    expect(validateClientRequest({ requestedOn: "2026-10-01", source: "Client app" }, "2026-10-05", "2026-10-21").ok).toBe(true);
    const errors = (input: { requestedOn: string; source: string }, first: string | null = null) => {
      const result = validateClientRequest(input, first, "2026-10-21");
      return result.ok ? [] : result.errors.map(error => error.message);
    };
    expect(errors({ requestedOn: "", source: "Client app" })).toEqual(["Enter the client request date."]);
    expect(errors({ requestedOn: "2026-10-22", source: "Client app" })[0]).toContain("future");
    expect(errors({ requestedOn: "2026-10-06", source: "Client app" }, "2026-10-05")[0]).toContain("after the first submission");
    expect(errors({ requestedOn: "2026-10-01", source: "Email" })[0]).toContain("request source");
  });
});

describe("createTransfer with the connected intake", () => {
  it("writes the directory client, household and linked deal", async () => {
    const tx = wire();
    await createTransfer(VALUES, { ...INTAKE, dealId: "deal-1", sourceMode: "deal", sourceType: "Individual" });
    expect(tx.transfer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ client_sf_id: "SF-TEST-1", archived_at: null }),
    }));
    expect(tx.transfer.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      client_first_name: "Test", client_last_name: "Client", client_sf_id: "SF-TEST-1",
      household_name: "Test Household", household_sf_id: "HH-TEST-1",
      deal_id: "deal-1", deal_sf_id: "SF-DEAL-1", value: 40000,
      transferring_firm: "Sample Deal Brokerage", source_account_type: "Individual", source_account_last4: "9312",
      delivering_custodian_id: null, funding_type: "ACAT_FULL", stage: "DECISION",
      accounts: { create: [{ label: "Individual · Test Client", status: "TO_OPEN", opened_at: null }] },
    }) });
    expect(redirectSpy).toHaveBeenCalledWith("/asset-transfer/new-1");
  });

  it("refuses a client that is not in the directory, and a deal linked elsewhere", async () => {
    const tx = wire();
    connections.readDirectoryClient.mockResolvedValueOnce(null);
    expect(await createTransfer(VALUES, INTAKE)).toEqual({ ok: false, errors: [expect.objectContaining({ field: "client" })] });
    connections.readDealOptions.mockResolvedValueOnce([{ ...DEAL, linkedTransferId: "T-OTHER" }]);
    expect(await createTransfer(VALUES, { ...INTAKE, dealId: "deal-1" })).toEqual({ ok: false, errors: [expect.objectContaining({ field: "dealId" })] });
    expect(await createTransfer(VALUES, { ...INTAKE, clientSfId: "" })).toEqual({ ok: false, errors: [expect.objectContaining({ field: "client" })] });
    expect(tx.transfer.create).not.toHaveBeenCalled();
  });

  it("does not read an asset map for a role that cannot link one", async () => {
    const tx = wire();
    const result = await createTransfer(VALUES, { ...INTAKE, sourceMode: "asset_map", assetMapAccountId: "acct-1" });
    expect(connections.readAssetMapSourceFacts).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, errors: [expect.objectContaining({ field: "assetMapAccountId" })] });
    expect(tx.transfer.create).not.toHaveBeenCalled();
  });

  it("links the client's own asset-map account and refuses one outside the client's folders", async () => {
    const tx = wire();
    authSpy.mockResolvedValue({ user: { email: "ops@example.test", role: "OPERATIONS" } });
    assetMapLinkSpy.mockReturnValue(true);
    connections.readAssetMapSourceFacts.mockResolvedValueOnce({
      facts: { institution: "Sample Map Custodian", type: "Roth IRA", last4: "7788", title: "Test Client" },
      key: { sourceFolderId: "folder-1", custodian: "Sample Map Custodian", accountNumber: "SYN0007788", accountType: "Roth IRA" },
    });
    await createTransfer(VALUES, { ...INTAKE, sourceMode: "asset_map", assetMapAccountId: "acct-1" });
    expect(connections.readAssetMapSourceFacts).toHaveBeenCalledWith(tx, "acct-1", { clientSfId: "SF-TEST-1", householdSfId: "HH-TEST-1" });
    expect(tx.transfer.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      asset_map_folder_id: "folder-1", asset_map_custodian: "Sample Map Custodian",
      asset_map_account_number: "SYN0007788", asset_map_account_type: "Roth IRA", source_account_last4: "7788",
    }) });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain("SYN0007788");
    tx.transfer.create.mockClear();
    connections.readAssetMapSourceFacts.mockResolvedValueOnce(null);
    expect(await createTransfer(VALUES, { ...INTAKE, sourceMode: "asset_map", assetMapAccountId: "acct-other" }))
      .toEqual({ ok: false, errors: [expect.objectContaining({ field: "assetMapAccountId" })] });
    expect(tx.transfer.create).not.toHaveBeenCalled();
    assetMapLinkSpy.mockReturnValue(false);
  });

  it("refuses a create without the directory intake while the workspace is on", async () => {
    const tx = wire();
    expect(await createTransfer(VALUES)).toEqual({ ok: false, errors: [expect.objectContaining({ field: "client" })] });
    expect(tx.transfer.create).not.toHaveBeenCalled();
  });

  it("refuses a source an active transfer is already moving", async () => {
    const tx = wire([dbRow()]);
    connections.readDealOptions.mockResolvedValue([{ ...DEAL, accountLast4: "1234", transferringFirm: "Sample Brokerage" }]);
    const result = await createTransfer(VALUES, { ...INTAKE, dealId: "deal-1", sourceMode: "deal", sourceType: "Roth IRA" });
    expect(result).toEqual({ ok: false, errors: [expect.objectContaining({ field: "sourceMode", message: expect.stringContaining("T-EXISTING") })] });
    expect(tx.transfer.create).not.toHaveBeenCalled();
  });

  it("allows the same source again once the earlier transfer is stopped, into an open Apex account", async () => {
    const tx = wire([dbRow({ outcomes: [{ outcome: "Canceled", resumed: false }] })]);
    connections.readApexAccountRows.mockResolvedValue([{ account_type: "Roth IRA", account_status: "Open", apex_account_number: "8PO446252" }]);
    const { openApexReceivingOptions } = await vi.importActual<typeof import("@/lib/data/transfer-connections")>("@/lib/data/transfer-connections");
    const [apex] = openApexReceivingOptions([{ account_type: "Roth IRA", account_status: "Open", apex_account_number: "8PO446252" }]);
    connections.readDealOptions.mockResolvedValue([{ ...DEAL, accountLast4: "1234", transferringFirm: "Sample Brokerage" }]);
    await createTransfer(VALUES, { ...INTAKE, dealId: "deal-1", sourceMode: "deal", sourceType: "Roth IRA", destinationMode: "apex", apexAccountKey: apex.key });
    expect(tx.transfer.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      transferring_firm: "Sample Brokerage", source_account_last4: "1234",
      accounts: { create: [expect.objectContaining({ label: "Roth IRA · Apex ••••6252", status: "OPEN" })] },
    }) });
  });

  it("keeps the role check and the flag for the intake", async () => {
    const tx = wire();
    authSpy.mockResolvedValue({ user: { email: "viewer@example.test", role: "VIEWER" } });
    expect((await createTransfer(VALUES, INTAKE))?.ok).toBe(false);
    authSpy.mockResolvedValue({ user: { email: "cs@example.test", role: "CLIENT_SERVICE" } });
    workspaceSpy.mockReturnValue(false);
    expect((await createTransfer(VALUES, INTAKE))?.ok).toBe(false);
    expect(tx.transfer.create).not.toHaveBeenCalled();
  });

  it("keeps the existing field validation", async () => {
    const tx = wire();
    const result = await createTransfer({ ...VALUES, client_first_name: "" }, INTAKE);
    expect(result?.ok).toBe(false);
    expect(tx.transfer.create).not.toHaveBeenCalled();
  });
});
