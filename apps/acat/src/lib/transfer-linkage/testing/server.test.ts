// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = mocks.verify; } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { createSyntheticHandler, startSyntheticServer } from "./server";
import { SYNTHETIC_INSTALLATION } from "./fixtures";
const dev = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const controller = "synthetic-controller@test-project.iam.gserviceaccount.com";
const req = (path: string, method = "GET", body?: unknown) => new Request(`https://synthetic.test${path}`, {
  method, headers: { authorization: "Bearer synthetic-token" }, ...(body ? { body: JSON.stringify(body) } : {}),
});
beforeEach(() => {
  vi.stubEnv("TRANSFER_LINKAGE_ENABLED", "true"); vi.stubEnv("TRANSFER_LINKAGE_ENVIRONMENT", "synthetic");
  vi.stubEnv("MACHINE_AUTH_AUDIENCE", "https://isolated-synthetic.test"); vi.stubEnv("TRANSFER_LINKAGE_ALLOWED_SAS", dev);
  vi.stubEnv("ACAT_SYNTHETIC_CONTROL_ALLOWED_SAS", controller);
  mocks.verify.mockResolvedValue({ getPayload: () => ({ email: dev, email_verified: true }) });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("isolated synthetic linkage producer", () => {
  it.skipIf(process.env.TRANSFER_LINKAGE_HTTP_TEST !== "1")("serves the frozen contract over native localhost HTTP and bounds request bodies", async () => {
    const server = startSyntheticServer(15544);
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const response = await fetch("http://127.0.0.1:15544/api/machine/transfer-linkage", { headers: { authorization: "Bearer synthetic-token" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ source: { installationId: SYNTHETIC_INSTALLATION }, recordCount: 2 });
      const oversized = await fetch("http://127.0.0.1:15544/__synthetic/epoch", { method: "POST", body: "x".repeat(257) });
      expect(oversized.status).toBe(413);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it("serves only synthetic contract data through the exact scoped OIDC gate", async () => {
    const handler = createSyntheticHandler();
    const response = await handler(req("/api/machine/transfer-linkage"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: { installationId: SYNTHETIC_INSTALLATION, environment: "synthetic" }, complete: true, recordCount: 2 });
    expect(mocks.verify).toHaveBeenCalledWith({ idToken: "synthetic-token", audience: "https://isolated-synthetic.test" });
    expect((await handler(req("/api/machine/transfer-linkage", "POST"))).status).toBe(401);
    expect((await handler(req("/api/machine/acats"))).status).toBe(404);
    expect(await (await handler(req("/api/machine/transfer-linkage/missing"))).json()).toMatchObject({ complete: false, outcome: "MISSING", record: null });
  });
  it("keeps private epoch control separate and exposes competitor/membership drift", async () => {
    const handler = createSyntheticHandler();
    const initial = await (await handler(req("/api/machine/transfer-linkage"))).json();
    expect((await handler(req("/__synthetic/epoch", "POST", { epoch: "new-competitor" }))).status).toBe(401);
    for (const epoch of ["late-arrival", "new-competitor", "membership-changed", "stale-directory"]) {
      mocks.verify.mockResolvedValue({ getPayload: () => ({ email: controller, email_verified: true }) });
      expect((await handler(req("/__synthetic/epoch", "POST", { epoch }))).status).toBe(200);
      mocks.verify.mockResolvedValue({ getPayload: () => ({ email: dev, email_verified: true }) });
      const snapshot = await (await handler(req("/api/machine/transfer-linkage"))).json();
      if (epoch === "stale-directory") expect(snapshot.directory.health).toBe("STALE");
      else expect(snapshot.snapshotDigest).not.toBe(initial.snapshotDigest);
    }
  });
  it("has no production fallback and rejects bad auth/configuration/control payload", async () => {
    const handler = createSyntheticHandler();
    vi.stubEnv("TRANSFER_LINKAGE_ENVIRONMENT", "production");
    expect((await handler(req("/api/machine/transfer-linkage"))).status).toBe(503);
    vi.stubEnv("TRANSFER_LINKAGE_ENVIRONMENT", "synthetic"); vi.stubEnv("MACHINE_AUTH_AUDIENCE", "");
    expect((await handler(req("/api/machine/transfer-linkage"))).status).toBe(503);
    vi.stubEnv("MACHINE_AUTH_AUDIENCE", "https://synthetic.test");
    mocks.verify.mockRejectedValue(new Error("wrong audience"));
    expect((await handler(req("/api/machine/transfer-linkage"))).status).toBe(401);
    mocks.verify.mockResolvedValue({ getPayload: () => ({ email: controller, email_verified: true }) });
    expect((await handler(req("/__synthetic/epoch", "POST", { epoch: "production" }))).status).toBe(400);
    expect((await handler(req("/__synthetic/epoch", "POST", { epoch: "baseline", extra: true }))).status).toBe(400);
  });
});
