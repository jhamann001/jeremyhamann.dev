import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), generate: vi.fn(),
  workspaceFlag: vi.fn(), paperworkFlag: vi.fn(), statement: vi.fn(), match: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("@/lib/forms/generate-form.server", () => ({ generateForm: spies.generate }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: spies.workspaceFlag,
  paperworkRecordsEnabled: spies.paperworkFlag,
}));
vi.mock("@/lib/transfers/intake-gates", () => ({
  statementBlocks: spies.statement,
  accountMatchBlocks: spies.match,
}));

import { POST } from "@/app/api/forms/generate/route";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";

const SUITE = "asset-transfer-paperwork-download";

const baseBody = {
  transferId: "synthetic-transfer",
  formId: ACAT_DEFINITION.id,
  clientId: "synthetic-client",
  accountIds: ["synthetic-account"],
  values: { accountHolderName: "TEST RECEIVING", accountHolderTaxId: "", confirmAccountTitle: true },
};
const baseTransfer = {
  client_sf_id: "synthetic-client",
  archived_at: null as Date | null,
  funding_plan_approved_at: new Date("2026-10-01T12:00:00Z") as Date | null,
  funding_type: "ACAT_FULL" as string | null,
};
const baseReview = {
  reviewed: true,
  receiving_form_title: "TEST RECEIVING",
  source_form_title: "TEST SOURCE",
  title_owners_confirmed: null,
  apex_account_id: "synthetic-account",
  form_id: ACAT_DEFINITION.id as string,
};

let transfer: typeof baseTransfer | null;
let review: typeof baseReview | null;
const empty = () => ({ findFirst: vi.fn(async () => null) });
let tx: Record<string, unknown>;

const send = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/forms/generate", { method: "POST", body: JSON.stringify(body) }));

async function expectRefused(body: Record<string, unknown> = baseBody) {
  const response = await send(body);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "paperwork_not_ready" });
}

beforeEach(() => {
  vi.clearAllMocks();
  transfer = { ...baseTransfer };
  review = { ...baseReview };
  tx = {
    transfer: { findUnique: vi.fn(async () => transfer) },
    transferFormReview: { findFirst: vi.fn(async () => review) },
    transferStatement: { findFirst: vi.fn(async () => ({ accepted: true })) },
    transferAccountMatch: { findFirst: vi.fn(async () => null) },
    transferAppAuthorization: empty(),
    transferSentPacket: empty(),
    transferReturnedSignature: empty(),
    transferMailedPaperwork: empty(),
    transferDrsServiceRequest: empty(),
  };
  spies.auth.mockResolvedValue({ user: { role: "CLIENT_SERVICE", email: "synthetic@example.test" } });
  spies.scope.mockImplementation(async (_identity, fn) => fn(tx));
  spies.generate.mockResolvedValue({
    ok: true,
    bytes: new Uint8Array([1]),
    filename: "synthetic.pdf",
    definition: { id: ACAT_DEFINITION.id, version: "synthetic" },
    reviewState: "ready_for_human_review",
    clientCompletionRequired: false,
    provenance: [],
  });
  spies.workspaceFlag.mockReturnValue(true);
  spies.paperworkFlag.mockReturnValue(true);
  spies.statement.mockReturnValue(false);
  spies.match.mockReturnValue(false);
});

describe("asset transfer paperwork download", () => {
  it("download-refused-unapproved", async () => {
    transfer = { ...baseTransfer, funding_plan_approved_at: null };
    await expectRefused();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-unapproved");
  });

  it("download-refused-unreviewed", async () => {
    review = { ...baseReview, reviewed: false };
    await expectRefused();
    review = null;
    await expectRefused();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-unreviewed");
  });

  it("download-refused-intake-blocked", async () => {
    spies.statement.mockReturnValue(true);
    await expectRefused();
    spies.statement.mockReturnValue(false);
    spies.match.mockReturnValue(true);
    await expectRefused();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-intake-blocked");
  });

  it("download-refused-other-client-or-form", async () => {
    await expectRefused({ ...baseBody, clientId: "synthetic-other-client" });
    await expectRefused({ ...baseBody, formId: IRA_BENEFICIARY_DEFINITION.id });
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-other-client-or-form");
  });

  it("download-refused-flag-off", async () => {
    spies.paperworkFlag.mockReturnValue(false);
    await expectRefused();
    spies.workspaceFlag.mockReturnValue(false);
    spies.paperworkFlag.mockReturnValue(true);
    await expectRefused();
    expect(spies.scope).not.toHaveBeenCalled();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-flag-off");
  });

  it("download-allowed", async () => {
    const response = await send(baseBody);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(spies.generate).toHaveBeenCalledTimes(1);
    expect(spies.generate.mock.calls[0][1]).toMatchObject({
      formId: ACAT_DEFINITION.id,
      clientId: "synthetic-client",
      accountIds: ["synthetic-account"],
    });
    markCase(SUITE, "download-allowed");
  });

  it("unrelated-form-unchanged", async () => {
    spies.workspaceFlag.mockReturnValue(false);
    spies.paperworkFlag.mockReturnValue(false);
    const { transferId: _omit, ...withoutTransfer } = baseBody;
    expect(_omit).toBe("synthetic-transfer");
    expect((await send(withoutTransfer)).status).toBe(200);
    expect(spies.generate).toHaveBeenCalledTimes(1);
    expect((await send({ ...withoutTransfer, transferId: "" })).status).toBe(200);
    expect(spies.generate).toHaveBeenCalledTimes(2);
    expect(spies.scope).not.toHaveBeenCalled();
    markCase(SUITE, "unrelated-form-unchanged");
  });

  it("download-refused-other-account", async () => {
    review = { ...baseReview, apex_account_id: "synthetic-account-a" };
    await expectRefused({ ...baseBody, accountIds: ["synthetic-account-b"] });
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-other-account");
  });

  it("download-refused-archived", async () => {
    transfer = { ...baseTransfer, archived_at: new Date("2026-10-02T12:00:00Z") };
    await expectRefused();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-archived");
  });

  it("download-refused-missing-transfer", async () => {
    transfer = null;
    await expectRefused();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-missing-transfer");
  });

  it("download-refused-missing-funding-type", async () => {
    transfer = { ...baseTransfer, funding_type: null };
    await expectRefused();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-missing-funding-type");
  });

  it("download-refused-stored-form-mismatch", async () => {
    review = { ...baseReview, form_id: IRA_BENEFICIARY_DEFINITION.id };
    await expectRefused();
    expect(spies.generate).not.toHaveBeenCalled();
    markCase(SUITE, "download-refused-stored-form-mismatch");
  });
});
