import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { LinkageError } from "@/lib/data/acat-link-contract";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  source: vi.fn(), targets: vi.fn(), rejected: vi.fn(), match: vi.fn(), prepare: vi.fn(), persist: vi.fn(), apply: vi.fn(),
  scope: vi.fn(), auth: vi.fn(), audit: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(),
}));
vi.mock("@/lib/data/acat-match-source", () => ({ fetchTransferLinkageSnapshot: mocks.source, readAcatCandidatesWithinScope: mocks.targets }));
vi.mock("@/lib/data/acat-auto-link", () => ({ applyAcatDecision: mocks.apply, readAcatRejectedPairsWithinScope: mocks.rejected }));
vi.mock("@/lib/data/acat-match", () => ({ matchAcatPopulation: mocks.match }));
vi.mock("@/lib/data/acat-reconciliation/prepare", () => ({ prepareManifestFromMatches: mocks.prepare }));
vi.mock("@/lib/data/acat-reconciliation/persistence", () => ({ prepareReconciliationRun: mocks.persist }));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: mocks.scope }));
vi.mock("@/lib/cron/acat-link-auth", () => ({ requireAcatLinkCronAuth: mocks.auth }));
vi.mock("@/lib/audit", () => ({ ACAT_LINK_RUN: "acat_link.run", writeAudit: mocks.audit }));
import { POST, GET, PATCH, PUT, DELETE } from "@/app/api/cron/acat-link-sync/route";

const request = (query = "", token = "synthetic-ingest") => new Request(`https://ops-portal.example.invalid/api/cron/acat-link-sync${query}`, {
  method: "POST", headers: { authorization: `Bearer ${token}` },
});
const summary = { tracker: { total: 2 }, aoa: { total: 1 } };
const SYNTHETIC_IDENTIFIER = "synthetic-client-0001";
const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError(`synthetic failure for ${SYNTHETIC_IDENTIFIER}`,
  { code, clientVersion: "synthetic" });
/** Runs one failing request and returns its single logged line. */
async function failedRun(): Promise<string> {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "source_or_database_unavailable" });
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0][0]);
    expect(line).not.toContain(SYNTHETIC_IDENTIFIER);
    expect(line).not.toContain("synthetic failure");
    return line;
  } finally { log.mockRestore(); }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockImplementation(async (req: Request) => req.headers.get("authorization") === "Bearer synthetic-ingest");
  vi.stubEnv("ACAT_AUTO_LINK", "1");
  vi.stubEnv("ACAT_LINK_REVIEW", "0");
  vi.stubEnv("AOA_WRITES_PAUSED", "0");
  mocks.source.mockResolvedValue({ source: { system: "transfer-tracker", installationId: "synthetic", environment: "synthetic" },
    observedAt: new Date().toISOString(), directory: { health: "FRESH", freshnessBasis: "FETCH_SUCCESS" } });
  mocks.targets.mockResolvedValue([]);
  mocks.rejected.mockResolvedValue([]);
  mocks.match.mockReturnValue([]);
  mocks.prepare.mockReturnValue({ manifest: { mode: "AUTOMATIC" }, summary });
  mocks.persist.mockResolvedValue({ runId: "synthetic-run", created: true });
  mocks.findMany.mockResolvedValue([{ id: "synthetic-decision", review_version: 0 }]);
  mocks.count.mockResolvedValue(0);
  mocks.apply.mockResolvedValue({ outcome: "APPLIED" });
  mocks.scope.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
    acatLinkDecision: { findMany: mocks.findMany, count: mocks.count }, acatLinkRun: { update: mocks.update },
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("ACAT linking scheduled route", () => {
  it("refuses unsupported methods", async () => {
    for (const method of [GET, PATCH, PUT, DELETE]) expect(method().status).toBe(405);
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("rejects unauthorized requests before reads and writes", async () => {
    expect((await POST(request("", "wrong"))).status).toBe(401);
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("is inert with the default-off flag or global maintenance gate", async () => {
    vi.stubEnv("ACAT_AUTO_LINK", "0");
    expect(await (await POST(request())).json()).toEqual({ disabled: true });
    vi.stubEnv("ACAT_AUTO_LINK", "1"); vi.stubEnv("AOA_WRITES_PAUSED", "1");
    expect(await (await POST(request())).json()).toEqual({ disabled: true });
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
  });
  it("preview performs no run, decision, link, or audit writes", async () => {
    expect(await (await POST(request("?mode=preview"))).json()).toEqual({ mode: "preview", summary });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("allows read-only preview with review enabled while automatic writes remain off", async () => {
    vi.stubEnv("ACAT_AUTO_LINK", "0");
    vi.stubEnv("ACAT_LINK_REVIEW", "1");
    expect(await (await POST(request("?mode=preview"))).json()).toEqual({ mode: "preview", summary });
    expect(await (await POST(request())).json()).toEqual({ disabled: true });
    expect(mocks.source).toHaveBeenCalledOnce();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("fetch failure prevents even run preparation", async () => {
    mocks.source.mockRejectedValueOnce(new Error(`synthetic failure for ${SYNTHETIC_IDENTIFIER}`));
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=source cause=unexpected");
    expect(mocks.scope).not.toHaveBeenCalled();
  });
  it.each([
    ["a source timeout", new LinkageError("SOURCE_UNAVAILABLE", "request_timeout"), "cause=SOURCE_UNAVAILABLE reason=request_timeout"],
    ["a source error status", new LinkageError("SOURCE_UNAVAILABLE", "http_status", 503), "cause=SOURCE_UNAVAILABLE reason=http_status status=503"],
    ["a source transport error", new LinkageError("SOURCE_UNAVAILABLE", "request_failed"), "cause=SOURCE_UNAVAILABLE reason=request_failed"],
    ["an unavailable directory", new LinkageError("DIRECTORY_UNAVAILABLE"), "cause=DIRECTORY_UNAVAILABLE"],
    ["an unlisted source status", new LinkageError("SOURCE_UNAVAILABLE", "http_status", 418), "cause=SOURCE_UNAVAILABLE reason=http_status"],
  ])("logs a stable cause for %s without writes", async (_name, error, cause) => {
    mocks.source.mockRejectedValueOnce(error);
    expect(await failedRun()).toBe(`[cron:acat-link-sync] run_failed phase=source ${cause}`);
    expect(mocks.scope).not.toHaveBeenCalled();
  });
  it("logs the Prisma code, not its message, when run preparation fails", async () => {
    mocks.scope.mockRejectedValueOnce(prismaError("P2024"));
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=prepare cause=database reason=P2024");
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("logs the database phase for selection and summary failures", async () => {
    mocks.findMany.mockRejectedValueOnce(new Prisma.PrismaClientInitializationError(`synthetic failure for ${SYNTHETIC_IDENTIFIER}`, "synthetic", "P1001"));
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=select cause=database reason=P1001");
    expect(mocks.apply).not.toHaveBeenCalled();
    mocks.update.mockRejectedValueOnce(prismaError("P2028"));
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=summary cause=database reason=P2028");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("logs fixed internal codes but never other error text", async () => {
    mocks.match.mockImplementationOnce(() => { throw new Error("acat_link_duplicate_population_ids"); });
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=prepare cause=internal reason=acat_link_duplicate_population_ids");
    mocks.match.mockImplementationOnce(() => { throw new Error(`acat_link ${SYNTHETIC_IDENTIFIER}`); });
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=prepare cause=unexpected");
  });
  it("falls back to the error class for unlisted database codes", async () => {
    mocks.scope.mockRejectedValueOnce(prismaError("P3009"));
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=prepare cause=database reason=known_request");
    mocks.scope.mockRejectedValueOnce(new Prisma.PrismaClientValidationError(`synthetic failure for ${SYNTHETIC_IDENTIFIER}`, { clientVersion: "synthetic" }));
    expect(await failedRun()).toBe("[cron:acat-link-sync] run_failed phase=prepare cause=database reason=validation");
  });
  it("prepares inside ingest scope and applies through the single guarded writer", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "automatic", runId: "synthetic-run", applied: 1, remaining: 0 });
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith({ decisionId: "synthetic-decision", identity: { role: "INGEST", email: null },
      mode: "automatic", expectedReviewVersion: 0 });
    expect(mocks.persist.mock.calls[0][2].sourceBoundary.source.environment).toBe("synthetic");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }));
  });
  it("records partial progress when source reads fail after an earlier committed decision", async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: "one", review_version: 0 }, { id: "two", review_version: 0 }]);
    mocks.apply.mockResolvedValueOnce({ outcome: "APPLIED" }).mockRejectedValueOnce(new Error("source down"));
    mocks.count.mockResolvedValueOnce(1);
    expect(await (await POST(request())).json()).toMatchObject({ applied: 1, blocked: 1, remaining: 1 });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PARTIAL" }) }));
  });
  it("stops immediately without final receipt writes if maintenance begins during a batch", async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: "one", review_version: 0 }, { id: "two", review_version: 0 }]);
    mocks.apply.mockImplementationOnce(async () => { vi.stubEnv("AOA_WRITES_PAUSED", "1"); return { outcome: "APPLIED" }; });
    expect(await (await POST(request())).json()).toMatchObject({ applied: 1, paused: true });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
