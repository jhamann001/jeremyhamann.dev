import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), allowedUser: vi.fn(), limit: vi.fn(), log: vi.fn(),
  prepare: vi.fn(), confirm: vi.fn(), generate: vi.fn(), document: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/machine-auth", () => ({ verifyMachineCaller: mocks.verify }));
vi.mock("@/lib/transfer-preparation-prisma", () => ({ transferPreparationPrisma: { allowedUser: { findUnique: mocks.allowedUser } } }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit: mocks.limit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.log } }));
vi.mock("@/lib/transfer-preparation-service", () => ({
  TransferPreparationError: class extends Error { constructor(public reason: string) { super(reason); } },
  getPreparation: mocks.prepare, confirmReceivingTitle: mocks.confirm, generateTransferForm: mocks.generate,
  getPreparationDocument: mocks.document, updateTransferScope: mocks.scope,
}));
import { GET, PUT, POST, PATCH } from "./route";
import { GET as DOWNLOAD } from "./documents/[documentId]/route";
import { TransferPreparationError } from "@/lib/transfer-preparation-service";
import { TRANSFER_GENERATION_MAX_BODY_BYTES } from "@/lib/transfer-preparation-http";

const SA = "ops-portal@example.iam.gserviceaccount.com";
const actor = "operator@example.test";
const revision = "a".repeat(64);
const operationId = "90cba8f7-2cec-4202-9e72-a2b14fd67129";
const context = { params: Promise.resolve({ id: "record-1" }) };
function req(method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://tracker.test/api/machine/acats/by-record/record-1/preparation", { method,
    headers: { authorization: "Bearer synthetic", "X-OpsPortal-Actor-Email": actor, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function paddedReq(method: string, body: unknown, byteLength: number) {
  const serialized = JSON.stringify(body);
  const request = req(method, body);
  return new Request(request.url, { method, headers: request.headers,
    body: serialized + " ".repeat(byteLength - Buffer.byteLength(serialized, "utf8")) });
}
const titleBody = { expectedRevision: revision, operationId, title: "Synthetic title", registration: "Traditional IRA", confirmed: true };
const scopeBody = { expectedRevision: revision, operationId, scope: "PARTIAL", confirmed: true };
const generateBody = { expectedRevision: revision, operationId, confirmationId: "confirmation-1", workflowId: "default-brokerage-firm-transfer",
  assetInstruction: "IN_KIND", deliveringTitle: "Synthetic source", deliveringTitleConfirmed: true,
  accountsReviewed: true, instructionsReviewed: true, letterOfAuthorizationRequired: false };
const methods = [
  { name: "read", invoke: () => GET(req(), context) },
  { name: "confirm", invoke: () => PUT(req("PUT", titleBody), context) },
  { name: "generate", invoke: () => POST(req("POST", generateBody), context) },
  { name: "download", invoke: () => DOWNLOAD(req(), { params: Promise.resolve({ id: "record-1", documentId: "document-1" }) }) },
  { name: "scope", invoke: () => PATCH(req("PATCH", scopeBody), context) },
];
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("OPS_PORTAL_TRANSFER_FORMS_ENABLED", "true"); vi.stubEnv("OPS_PORTAL_TRANSFER_FORMS_ALLOWED_SAS", SA);
  mocks.verify.mockResolvedValue({ email: SA }); mocks.allowedUser.mockResolvedValue({ active: true, role: "USER" });
  mocks.limit.mockResolvedValue({ allowed: true }); mocks.prepare.mockResolvedValue({ schemaVersion: 1 });
  mocks.confirm.mockResolvedValue({ confirmation: { id: "confirmation-1" } }); mocks.generate.mockResolvedValue({ documentId: "document-1" });
  mocks.scope.mockResolvedValue({ schemaVersion: 1, scope: "PARTIAL", sourceRevision: "b".repeat(64) });
  mocks.document.mockResolvedValue({ id: "document-1", filename: "synthetic.pdf", sha256: revision, content: Buffer.from("%PDF-synthetic") });
});
afterEach(() => vi.unstubAllEnvs());

describe("dedicated Ops Portal preparation machine boundary", () => {
  it.each(methods)("fails closed when disabled for $name", async ({ invoke }) => {
    vi.stubEnv("OPS_PORTAL_TRANSFER_FORMS_ENABLED", "false"); const response = await invoke();
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "disabled" });
    expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it.each(methods)("requires the explicit preparation grant for $name", async ({ invoke }) => {
    vi.stubEnv("OPS_PORTAL_TRANSFER_FORMS_ALLOWED_SAS", ""); const response = await invoke();
    expect(response.status).toBe(403); expect(mocks.allowedUser).not.toHaveBeenCalled();
  });
  it.each(methods)("rejects invalid OIDC caller for $name", async ({ invoke }) => {
    mocks.verify.mockResolvedValue(null); expect((await invoke()).status).toBe(403); expect(mocks.allowedUser).not.toHaveBeenCalled();
  });
  it.each([null, { active: false, role: "USER" }, { active: true, role: "ADVISOR" }])("rejects revoked/read-only human %j", async (user) => {
    mocks.allowedUser.mockResolvedValue(user);
    for (const { invoke } of methods) expect((await invoke()).status).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("rejects a missing/malformed actor and applies rate limit before source access", async () => {
    expect((await GET(req("GET", undefined, { "X-OpsPortal-Actor-Email": "" }), context)).status).toBe(403);
    mocks.limit.mockResolvedValue({ allowed: false });
    expect((await GET(req(), context)).status).toBe(503); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("forwards only the strict parsed request and verified human/service origin", async () => {
    expect((await PUT(req("PUT", titleBody), context)).status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith("record-1", titleBody, { email: actor, serviceAccount: SA });
    expect((await POST(req("POST", { ...generateBody, actor: "spoof@example.test" }), context)).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect((await POST(req("POST", generateBody), context)).status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith("record-1", generateBody, { email: actor, serviceAccount: SA });
  });
  it.each(["IRA", "Joint", "Inherited IRA", "Other", "Individul", "Brokerage / Individual", "constructor", "__proto__"])("rejects noncanonical registration %s before saving", async (registration) => {
    const response = await PUT(req("PUT", { ...titleBody, registration }), context);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid" });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("authenticates scope changes and returns their current source revision without caching", async () => {
    const response = await PATCH(req("PATCH", scopeBody), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ schemaVersion: 1, scope: "PARTIAL", sourceRevision: "b".repeat(64) });
    expect(mocks.scope).toHaveBeenCalledWith("record-1", scopeBody, { email: actor, serviceAccount: SA });
  });
  it.each([
    { scope: "UNKNOWN" }, { scope: "Full" }, { confirmed: false }, { confirmed: undefined },
    { expectedRevision: "stale-label" }, { operationId: "not-a-uuid" },
    { assets: [{ id: "position-1", includeInTransfer: true }] },
    { type: "Full" }, { status: "Submitted" }, { actor: "spoof@example.test" },
  ])("rejects unsupported or extra scope fields before any write", async (change) => {
    const response = await PATCH(req("PATCH", { ...scopeBody, ...change }), context);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid" });
    expect(mocks.scope).not.toHaveBeenCalled();
  });
  it("rate limits scope changes before any source write and keeps stale failures opaque", async () => {
    mocks.limit.mockResolvedValueOnce({ allowed: false });
    expect((await PATCH(req("PATCH", scopeBody), context)).status).toBe(503);
    expect(mocks.scope).not.toHaveBeenCalled();
    mocks.scope.mockRejectedValue(new TransferPreparationError("stale"));
    const response = await PATCH(req("PATCH", scopeBody), context);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "stale" });
  });
  it("returns exact archive bytes with integrity headers and no caching", async () => {
    const response = await methods[3].invoke();
    expect(response.status).toBe(200); expect(await response.text()).toBe("%PDF-synthetic");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-transfer-document-sha256")).toBe(revision);
    expect(response.headers.get("x-transfer-document-id")).toBe("document-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["invalid", "not_found", "stale", "review_required"] as const)("keeps %s failures opaque", async (reason) => {
    mocks.generate.mockRejectedValue(new TransferPreparationError(reason));
    const response = await POST(req("POST", generateBody), context);
    expect(response.status).toBe(reason === "invalid" ? 400 : reason === "not_found" ? 404 : 409);
    expect(await response.json()).toEqual({ error: reason });
  });
  it("does not expose raw failure details in responses or logs", async () => {
    mocks.prepare.mockRejectedValue(new Error("secret account 987654321 title private"));
    const response = await GET(req(), context);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/secret|987654321|private/);
  });
  it("rejects malformed IDs and oversized requests without invoking services", async () => {
    expect((await GET(req(), { params: Promise.resolve({ id: "../other" }) })).status).toBe(400);
    expect((await PUT(req("PUT", { ...titleBody, title: "a".repeat(17000) }), context)).status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it.each([{ count: 250, idLength: 25 }, { count: 5000, idLength: 128 }])("parses valid mixed generation maps of $count rows and $idLength-character IDs over 16 KiB", async ({ count, idLength }) => {
    const packet = { ...generateBody, assetInstruction: "MIXED", positionInstructions: Array.from({ length: count }, (_, index) => ({
      positionId: `p${String(index).padStart(idLength - 1, "0")}`, assetInstruction: index % 2 ? "LIQUIDATE" : "IN_KIND",
    })) };
    const byteLength = Buffer.byteLength(JSON.stringify(packet), "utf8");
    expect(byteLength).toBeGreaterThan(16 * 1024);
    expect(byteLength).toBeLessThan(TRANSFER_GENERATION_MAX_BODY_BYTES);
    expect((await POST(req("POST", packet), context)).status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith("record-1", packet, { email: actor, serviceAccount: SA });
  });
  it("accepts exactly the generation byte cap and rejects one byte over it before source access", async () => {
    expect(TRANSFER_GENERATION_MAX_BODY_BYTES).toBe(1024 * 1024);
    expect((await POST(paddedReq("POST", generateBody, TRANSFER_GENERATION_MAX_BODY_BYTES), context)).status).toBe(200);
    mocks.generate.mockClear();
    const response = await POST(paddedReq("POST", generateBody, TRANSFER_GENERATION_MAX_BODY_BYTES + 1), context);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each([
    { method: "PUT", body: { ...titleBody, title: "Élodie Synthetic" }, handler: PUT, mock: mocks.confirm },
    { method: "PATCH", body: scopeBody, handler: PATCH, mock: mocks.scope },
  ])("keeps the $method body limit at exactly 16 KiB, including UTF-8 byte counting", async ({ method, body, handler, mock }) => {
    expect((await handler(paddedReq(method, body, 16 * 1024), context)).status).toBe(200);
    mock.mockClear();
    const response = await handler(paddedReq(method, body, 16 * 1024 + 1), context);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid" });
    expect(mock).not.toHaveBeenCalled();
  });
});
