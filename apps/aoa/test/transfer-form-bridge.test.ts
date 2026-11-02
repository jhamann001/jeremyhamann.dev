import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { request, getIdTokenClient } = vi.hoisted(() => ({ request: vi.fn(), getIdTokenClient: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getIdTokenClient = getIdTokenClient; } }));
import { loadTrackerTransferForm, confirmTrackerReceivingTitle, updateTrackerTransferScope, generateTrackerTransferForm, downloadTrackerTransferForm } from "@/lib/data/transfer-form-bridge";
import { transferFormFixture, confirmTitleFixture, generateTransferFixture } from "./fixtures/transfer-form";

const actor = { email: "SYNTHETIC@example.test", role: "OPERATIONS" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AOA_TRANSFER_FORMS_ENABLED", "true");
  vi.stubEnv("TRANSFER_TRACKER_URL", "https://tracker.example.test/");
  getIdTokenClient.mockResolvedValue({ request });
  request.mockResolvedValue({ status: 200, data: structuredClone(transferFormFixture) });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("transfer form bridge", () => {
  it("uses the configured audience, server actor and stable record id without retries/redirects", async () => {
    expect(await loadTrackerTransferForm(actor, "sample-record")).toEqual(transferFormFixture);
    expect(getIdTokenClient).toHaveBeenCalledWith("https://tracker.example.test");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://tracker.example.test/api/machine/acats/by-record/sample-record/preparation", method: "GET", retry: false, maxRedirects: 0,
      headers: { "Cache-Control": "no-store", "X-Aoa-Actor-Email": "synthetic@example.test" },
    }));
  });
  it.each(["CLIENT_SERVICE", "ADVISOR", "VIEWER", "UNKNOWN", ""])("rejects %s before credential discovery", async role => {
    await expect(loadTrackerTransferForm({ ...actor, role }, "sample-record")).rejects.toMatchObject({ reason: "forbidden" });
    expect(getIdTokenClient).not.toHaveBeenCalled();
  });
  it.each(["", "bad\r\nheader", "not-an-email"])("rejects invalid human identity %j", async email => {
    await expect(loadTrackerTransferForm({ ...actor, email }, "sample-record")).rejects.toMatchObject({ reason: "forbidden" });
    expect(request).not.toHaveBeenCalled();
  });
  it("is disabled by default with no credential discovery", async () => {
    vi.stubEnv("AOA_TRANSFER_FORMS_ENABLED", "");
    await expect(loadTrackerTransferForm(actor, "sample-record")).rejects.toMatchObject({ reason: "disabled" });
    expect(getIdTokenClient).not.toHaveBeenCalled();
  });
  it.each(["", "http://localhost:3000", "https://name:password@example.test", "https://example.test/path", "https://example.test/?q=1"])("rejects invalid or implicit origin %j", async origin => {
    vi.stubEnv("TRANSFER_TRACKER_URL", origin);
    await expect(loadTrackerTransferForm(actor, "sample-record")).rejects.toMatchObject({ reason: "unavailable" });
    expect(getIdTokenClient).not.toHaveBeenCalled();
  });
  it("names a missing tracker origin in one bounded log line", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("TRANSFER_TRACKER_URL", undefined);
    await expect(loadTrackerTransferForm(actor, "sample-record")).rejects.toMatchObject({ reason: "unavailable" });
    expect(error).toHaveBeenCalledWith("[transfer-form-bridge] tracker_origin_unset");
    expect(getIdTokenClient).not.toHaveBeenCalled();
    error.mockRestore();
  });
  it.each(["", "../other", "record?q=1", "x".repeat(129)])("rejects bad record id %j", async id => {
    await expect(loadTrackerTransferForm(actor, id)).rejects.toMatchObject({ reason: "invalid" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...transferFormFixture, schemaVersion: 2 }, { ...transferFormFixture, recordId: "different-record" }])("rejects malformed/wrong record results", async data => {
    request.mockResolvedValue({ status: 200, data });
    await expect(loadTrackerTransferForm(actor, "sample-record")).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("strips source fields that were not approved for the UI", async () => {
    request.mockResolvedValue({ status: 200, data: { ...transferFormFixture, fullAccountNumber: "private", accounts: { ...transferFormFixture.accounts, fullAccountNumber: "private" } } });
    expect(JSON.stringify(await loadTrackerTransferForm(actor, "sample-record"))).not.toContain("private");
  });
  it.each([[503,"disabled","disabled"],[403,"forbidden","forbidden"],[404,"not_found","not_found"],[409,"stale","stale"],[409,"review_required","review_required"],[500,"private-error","unavailable"]])("returns only bounded failure %s %s", async (status, error, reason) => {
    request.mockResolvedValue({ status, data: { error, private: "secret" } });
    await expect(loadTrackerTransferForm(actor, "sample-record")).rejects.toMatchObject({ reason, message: "Transfer form operation unavailable" });
  });
  it("validates save/generation payloads and rejects forged attribution", async () => {
    await expect(confirmTrackerReceivingTitle(actor, "sample-record", { ...confirmTitleFixture, confirmedBy: "forged" } as never)).rejects.toMatchObject({ reason: "invalid" });
    await expect(generateTrackerTransferForm(actor, "sample-record", { ...generateTransferFixture, receivingAccountNumberVerified: false } as never)).rejects.toMatchObject({ reason: "invalid" });
    expect(request).not.toHaveBeenCalled();
  });
  it("sends exact explicit choices and preserves operation ids for retry", async () => {
    await confirmTrackerReceivingTitle(actor, "sample-record", confirmTitleFixture);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: "PUT", data: confirmTitleFixture }));
    request.mockResolvedValue({ status: 200, data: { documentId: "doc-1", ignored: "private" } });
    expect(await generateTrackerTransferForm(actor, "sample-record", generateTransferFixture)).toEqual({ documentId: "doc-1" });
    await generateTrackerTransferForm(actor, "sample-record", generateTransferFixture);
    expect(request.mock.calls.slice(-2).map(([call]) => call.data.operationId)).toEqual([generateTransferFixture.operationId, generateTransferFixture.operationId]);
  });
  it.each(["Indivdual", "individual", "Other", "IRA", "", "Synthetic Test Client - 3"])("rejects unclassified registration %j before sending a confirmation", async registration => {
    await expect(confirmTrackerReceivingTitle(actor, "sample-record", { ...confirmTitleFixture, registration } as never)).rejects.toMatchObject({ reason: "invalid" });
    expect(request).not.toHaveBeenCalled();
    expect(getIdTokenClient).not.toHaveBeenCalled();
  });
  it("sends mixed partial choices by stable position ID without rewriting them", async () => {
    const input = { ...generateTransferFixture, assetInstruction: "MIXED" as const, positionInstructions: [
      { positionId: "holding-a", assetInstruction: "IN_KIND" as const },
      { positionId: "holding-b", assetInstruction: "LIQUIDATE" as const },
    ] };
    request.mockResolvedValue({ status: 200, data: { documentId: "mixed-doc" } });
    expect(await generateTrackerTransferForm(actor, "sample-record", input)).toEqual({ documentId: "mixed-doc" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ data: input }));
  });
  it("patches scope with the authenticated actor, source revision and unchanged retry ID", async () => {
    const input = { expectedRevision: "a".repeat(64), operationId: "c4b6a222-628d-4e71-951b-79c06ff00e03", scope: "PARTIAL" as const, confirmed: true as const };
    request.mockResolvedValue({ status: 200, data: { ...transferFormFixture, scope: "PARTIAL", sourceRevision: "b".repeat(64) } });
    expect((await updateTrackerTransferScope(actor, "sample-record", input)).scope).toBe("PARTIAL");
    await updateTrackerTransferScope(actor, "sample-record", input);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: "PATCH", data: input, retry: false, headers: { "Cache-Control": "no-store", "X-Aoa-Actor-Email": "synthetic@example.test" } }));
    expect(request.mock.calls.map(([call]) => call.data.operationId)).toEqual([input.operationId, input.operationId]);
  });
  it.each([{ scope: "UNKNOWN" }, { confirmed: false }, { expectedRevision: "bad" }, { operationId: "bad" }, { performedBy: "forged" }, { positions: [] }])("rejects invalid or expanded scope changes before transport", async change => {
    await expect(updateTrackerTransferScope(actor, "sample-record", { expectedRevision: "a".repeat(64), operationId: "c4b6a222-628d-4e71-951b-79c06ff00e03", scope: "FULL", confirmed: true, ...change } as never)).rejects.toMatchObject({ reason: "invalid" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { assetInstruction: "MIXED" },
    { assetInstruction: "MIXED", positionInstructions: [{ positionId: "a", assetInstruction: "IN_KIND" }, { positionId: "a", assetInstruction: "LIQUIDATE" }] },
    { assetInstruction: "MIXED", positionInstructions: [{ positionId: "a", assetInstruction: "IN_KIND" }, { positionId: "b", assetInstruction: "IN_KIND" }] },
    { assetInstruction: "IN_KIND", positionInstructions: [{ positionId: "a", assetInstruction: "IN_KIND" }, { positionId: "b", assetInstruction: "LIQUIDATE" }] },
    { assetInstruction: "MIXED", positionInstructions: [{ positionId: "a", assetInstruction: "IN_KIND", quantity: 100 }, { positionId: "b", assetInstruction: "LIQUIDATE" }] },
  ])("rejects ambiguous or caller-modified mixed instructions before transport", async change => {
    await expect(generateTrackerTransferForm(actor, "sample-record", { ...generateTransferFixture, ...change } as never)).rejects.toMatchObject({ reason: "invalid" });
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds credentials and does not launch a late mutation after timeout", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    getIdTokenClient.mockReturnValue(new Promise(done => { resolve = done; }));
    const result = generateTrackerTransferForm(actor, "sample-record", generateTransferFixture).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ reason: "unavailable" });
    resolve({ request });
    await vi.advanceTimersByTimeAsync(1);
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds source read and redacts transport errors", async () => {
    request.mockRejectedValue(new Error("Bearer private-token account-number"));
    await expect(loadTrackerTransferForm(actor, "sample-record")).rejects.toThrow("Transfer form operation unavailable");
    vi.useFakeTimers();
    request.mockReturnValue(new Promise(() => {}));
    const result = loadTrackerTransferForm(actor, "sample-record").catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ reason: "unavailable" });
    expect(request.mock.calls.at(-1)?.[0].signal.aborted).toBe(true);
  });
});

describe("exact archived PDF download", () => {
  const bytes = Buffer.from("%PDF-1.7\nsynthetic document\n%%EOF");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const headers = { "content-type": "application/pdf", "x-transfer-document-id": "doc-1", "x-transfer-document-sha256": digest };
  it("verifies archive identity/hash and returns the same bytes", async () => {
    request.mockResolvedValue({ status: 200, data: bytes, headers });
    const result = await downloadTrackerTransferForm(actor, "sample-record", "doc-1");
    expect(result.bytes.equals(bytes)).toBe(true);
    expect(result.sha256).toBe(digest);
    expect(result.filename).toBe("transfer-doc-1.pdf");
  });
  it.each([
    { data: Buffer.from("html") }, { headers: { ...headers, "content-type": "text/html" } },
    { headers: { ...headers, "x-transfer-document-id": "other" } },
    { headers: { ...headers, "x-transfer-document-sha256": "a".repeat(64) } },
  ])("rejects mismatched/corrupt archive responses", async change => {
    request.mockResolvedValue({ status: 200, data: bytes, headers, ...change });
    await expect(downloadTrackerTransferForm(actor, "sample-record", "doc-1")).rejects.toMatchObject({ reason: "unavailable" });
  });
});
