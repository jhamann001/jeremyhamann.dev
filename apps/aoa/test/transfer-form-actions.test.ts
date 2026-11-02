import { beforeEach, describe, expect, it, vi } from "vitest";
const { authMock, load, confirm, updateScope, generate, download } = vi.hoisted(() => ({ authMock: vi.fn(), load: vi.fn(), confirm: vi.fn(), updateScope: vi.fn(), generate: vi.fn(), download: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/data/transfer-form-bridge", () => ({
  loadTrackerTransferForm: load, confirmTrackerReceivingTitle: confirm, updateTrackerTransferScope: updateScope, generateTrackerTransferForm: generate, downloadTrackerTransferForm: download,
  TransferFormBridgeError: class extends Error { constructor(readonly reason: string) { super("Transfer form operation unavailable"); } },
}));
import { loadTransferForm, confirmReceivingTitle, updateTransferScope, generateTransferForm } from "@/app/(authenticated)/acat-tracking/form-actions";
import { GET } from "@/app/api/transfers/[recordId]/forms/[documentId]/route";
import { TransferFormBridgeError } from "@/lib/data/transfer-form-bridge";
import { transferFormFixture, confirmTitleFixture, generateTransferFixture } from "./fixtures/transfer-form";

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { email: "staff@example.test", role: "OPERATIONS" } });
  load.mockResolvedValue(transferFormFixture);
  confirm.mockResolvedValue(transferFormFixture);
  updateScope.mockResolvedValue(transferFormFixture);
  generate.mockResolvedValue({ documentId: "document-1" });
  download.mockResolvedValue({ bytes: Buffer.from("%PDF-1.7 synthetic"), filename: "transfer-document-1.pdf", sha256: "a".repeat(64) });
});
const request = () => new Request("https://ops-portal.example.test/api/transfers/sample-record/forms/document-1");
const context = () => ({ params: Promise.resolve({ recordId: "sample-record", documentId: "document-1" }) });
const scopeInput = { expectedRevision: "a".repeat(64), operationId: "c4b6a222-628d-4e71-951b-79c06ff00e03", scope: "FULL" as const, confirmed: true as const };

describe("authenticated transfer form operations", () => {
  it.each([null, { user: {} }, { user: { role: "ADMIN" } }, ...["CLIENT_SERVICE", "ADVISOR", "VIEWER"].map(role => ({ user: { email: "staff@example.test", role } }))])("blocks every operation before calling the bridge", async session => {
    authMock.mockResolvedValue(session);
    expect(await loadTransferForm("sample-record")).toEqual({ ok: false, reason: "forbidden" });
    expect(await confirmReceivingTitle("sample-record", confirmTitleFixture)).toEqual({ ok: false, reason: "forbidden" });
    expect(await updateTransferScope("sample-record", scopeInput)).toEqual({ ok: false, reason: "forbidden" });
    expect(await generateTransferForm("sample-record", generateTransferFixture)).toEqual({ ok: false, reason: "forbidden" });
    expect((await GET(request(), context())).status).toBe(403);
    for (const dependency of [load, confirm, updateScope, generate, download]) expect(dependency).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "OPERATIONS"])("uses current authenticated %s identity on every call", async role => {
    authMock.mockResolvedValue({ user: { email: "staff@example.test", role } });
    expect((await loadTransferForm("sample-record")).ok).toBe(true);
    expect((await confirmReceivingTitle("sample-record", confirmTitleFixture)).ok).toBe(true);
    expect((await updateTransferScope("sample-record", scopeInput)).ok).toBe(true);
    expect(await generateTransferForm("sample-record", generateTransferFixture)).toEqual({ ok: true, data: { documentId: "document-1" } });
    expect((await GET(request(), context())).status).toBe(200);
    expect(authMock).toHaveBeenCalledTimes(5);
    for (const dependency of [load, confirm, updateScope, generate, download]) expect(dependency.mock.calls[0][0]).toEqual({ email: "staff@example.test", role });
    expect(confirm.mock.calls[0].slice(1)).toEqual(["sample-record", confirmTitleFixture]);
    expect(updateScope.mock.calls[0].slice(1)).toEqual(["sample-record", scopeInput]);
    expect(generate.mock.calls[0].slice(1)).toEqual(["sample-record", generateTransferFixture]);
  });
  it("forwards only controlled errors and redacts unexpected source failures", async () => {
    load.mockRejectedValue(new Error("private source payload"));
    expect(await loadTransferForm("sample-record")).toEqual({ ok: false, reason: "unavailable" });
    confirm.mockRejectedValue(new TransferFormBridgeError("stale"));
    expect(await confirmReceivingTitle("sample-record", confirmTitleFixture)).toEqual({ ok: false, reason: "stale" });
    updateScope.mockRejectedValue(new TransferFormBridgeError("stale"));
    expect(await updateTransferScope("sample-record", scopeInput)).toEqual({ ok: false, reason: "stale" });
  });
  it("reauthorizes an archive download and returns private non-cacheable bytes", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toContain("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="transfer-document-1.pdf"');
    expect(await response.text()).toBe("%PDF-1.7 synthetic");
    authMock.mockResolvedValue(null);
    expect((await GET(request(), context())).status).toBe(403);
    expect(download).toHaveBeenCalledTimes(1);
  });
  it.each([["forbidden",403],["not_found",404],["invalid",400],["disabled",503],["unavailable",503]] as const)("maps archive failure %s without exposing source data", async (reason, status) => {
    download.mockRejectedValue(new TransferFormBridgeError(reason));
    const response = await GET(request(), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: reason });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
