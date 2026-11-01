import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";

// Shared verifyIdToken spy the mocked OAuth2Client delegates to. Mirrors the
// google-auth-library mocking style used by gcp-auth.test.ts.
const mockVerifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: class MockOAuth2Client {
    verifyIdToken = mockVerifyIdToken;
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const ALLOWED_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV_LIBRARY_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const DEFAULT_AUDIENCE = "https://transfer-tracker.invalid";

function makeRequest(authHeader?: string): Request {
  return new Request("http://localhost/api/machine/acats/abc-123", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

// A minimal ID-token payload as returned by ticket.getPayload().
function payload(overrides: Record<string, unknown> = {}) {
  return { email: ALLOWED_SA, email_verified: true, ...overrides };
}

function ticketReturning(p: Record<string, unknown> | undefined) {
  return { getPayload: () => p };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  delete process.env.TRANSFER_LINKAGE_ENABLED;
  delete process.env.TRANSFER_LINKAGE_ALLOWED_SAS;
  delete process.env.TRANSFER_LINKAGE_ENVIRONMENT;
});

describe("verifyDashboardCaller", () => {
  const request = (path: string, method: string, email: string) => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
    return new Request(`https://tracker.test${path}`, {
      method,
      headers: { authorization: "Bearer synthetic" },
    });
  };

  it("dashboard read requires exact GET route", async () => {
    const { verifyDashboardCaller } = await import("./machine-auth");
    expect(await verifyDashboardCaller(request("/api/machine/dashboard", "GET", ALLOWED_SA), "read")).toEqual({ email: ALLOWED_SA });
    expect(await verifyDashboardCaller(request("/api/machine/dashboard/", "GET", ALLOWED_SA), "read")).toBeNull();
    expect(await verifyDashboardCaller(request("/api/machine/dashboard", "POST", ALLOWED_SA), "read")).toBeNull();
  });

  it("dashboard write requires exact POST route", async () => {
    const { verifyDashboardCaller } = await import("./machine-auth");
    expect(await verifyDashboardCaller(request("/api/machine/dashboard/reviews", "POST", ALLOWED_SA), "write")).toEqual({ email: ALLOWED_SA });
    expect(await verifyDashboardCaller(request("/api/machine/dashboard/reviews", "GET", ALLOWED_SA), "write")).toBeNull();
  });

  it("dashboard read accepts scoped dev identity", async () => {
    const { verifyDashboardCaller } = await import("./machine-auth");
    expect(await verifyDashboardCaller(request("/api/machine/dashboard", "GET", DEV_LIBRARY_SA), "read")).toEqual({ email: DEV_LIBRARY_SA });
  });

  it("dashboard write rejects scoped dev identity", async () => {
    const { verifyDashboardCaller } = await import("./machine-auth");
    expect(await verifyDashboardCaller(request("/api/machine/dashboard/reviews", "POST", DEV_LIBRARY_SA), "write")).toBeNull();
  });
});

describe("verifySecurityReconCaller", () => {
  const record = "/api/machine/acats/by-record/rec-1/security-recon";
  const request = (path: string, method: string, email: string) => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
    return new Request(`https://tracker.test${path}`, {
      method,
      headers: { authorization: "Bearer synthetic" },
    });
  };

  it("security recon read requires exact GET route", async () => {
    const { verifySecurityReconCaller } = await import("./machine-auth");
    expect(await verifySecurityReconCaller(request(record, "GET", ALLOWED_SA), "read")).toEqual({ email: ALLOWED_SA });
    expect(await verifySecurityReconCaller(request(`${record}/`, "GET", ALLOWED_SA), "read")).toBeNull();
    expect(await verifySecurityReconCaller(request(`${record}/accounts`, "GET", ALLOWED_SA), "read")).toBeNull();
    expect(await verifySecurityReconCaller(request(record, "POST", ALLOWED_SA), "read")).toBeNull();
    expect(await verifySecurityReconCaller(request(`${record}/accounts`, "GET", ALLOWED_SA), "search")).toEqual({ email: ALLOWED_SA });
    expect(await verifySecurityReconCaller(request(record, "GET", ALLOWED_SA), "search")).toBeNull();
  });

  it("security recon write requires exact POST route", async () => {
    const { verifySecurityReconCaller } = await import("./machine-auth");
    expect(await verifySecurityReconCaller(request(record, "POST", ALLOWED_SA), "write")).toEqual({ email: ALLOWED_SA });
    expect(await verifySecurityReconCaller(request(record, "GET", ALLOWED_SA), "write")).toBeNull();
    expect(await verifySecurityReconCaller(request(record, "PATCH", ALLOWED_SA), "write")).toBeNull();
    expect(await verifySecurityReconCaller(request(`${record}/accounts`, "POST", ALLOWED_SA), "write")).toBeNull();
  });

  it("security recon read accepts scoped dev identity", async () => {
    const { verifySecurityReconCaller } = await import("./machine-auth");
    expect(await verifySecurityReconCaller(request(record, "GET", DEV_LIBRARY_SA), "read")).toEqual({ email: DEV_LIBRARY_SA });
    expect(await verifySecurityReconCaller(request(`${record}/accounts`, "GET", DEV_LIBRARY_SA), "search")).toEqual({ email: DEV_LIBRARY_SA });
  });

  it("security recon write follows the configured allow-list", async () => {
    const { verifySecurityReconCaller } = await import("./machine-auth");
    // Code default (production identity only): the dev identity is refused.
    expect(await verifySecurityReconCaller(request(record, "POST", DEV_LIBRARY_SA), "write")).toBeNull();
    // Deployed allow-list (ticket: both Ops Portal identities may write): admitted.
    process.env.MACHINE_AUTH_ALLOWED_SAS = `${ALLOWED_SA},${DEV_LIBRARY_SA}`;
    expect(await verifySecurityReconCaller(request(record, "POST", DEV_LIBRARY_SA), "write")).toEqual({ email: DEV_LIBRARY_SA });
  });

  it("security recon rejects a non-allow-listed identity on every access", async () => {
    const { verifySecurityReconCaller } = await import("./machine-auth");
    const stranger = "stranger@example.test";
    expect(await verifySecurityReconCaller(request(record, "GET", stranger), "read")).toBeNull();
    expect(await verifySecurityReconCaller(request(`${record}/accounts`, "GET", stranger), "search")).toBeNull();
    expect(await verifySecurityReconCaller(request(record, "POST", stranger), "write")).toBeNull();
  });
});

describe("verifyTransferLinkageCaller", () => {
  const request = (path = "/api/machine/transfer-linkage", method = "GET") =>
    new Request(`https://tracker.test${path}`, { method, headers: { authorization: "Bearer synthetic" } });
  function configure() {
    process.env.TRANSFER_LINKAGE_ENABLED = "true";
    process.env.TRANSFER_LINKAGE_ENVIRONMENT = "production";
    process.env.TRANSFER_LINKAGE_ALLOWED_SAS = ALLOWED_SA;
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload()));
  }
  it("defaults off and never inherits existing global/dev read grants", async () => {
    const { verifyTransferLinkageCaller } = await import("./machine-auth");
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toBeNull();
    process.env.TRANSFER_LINKAGE_ENABLED = "true";
    process.env.TRANSFER_LINKAGE_ENVIRONMENT = "production";
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
  it("permits only exact snapshot/record GET scopes", async () => {
    configure();
    const { verifyTransferLinkageCaller } = await import("./machine-auth");
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toEqual({ email: ALLOWED_SA });
    expect(await verifyTransferLinkageCaller(request("/api/machine/transfer-linkage/synthetic-record"), "record")).toEqual({ email: ALLOWED_SA });
    mockVerifyIdToken.mockClear();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) expect(await verifyTransferLinkageCaller(request(undefined, method), "snapshot")).toBeNull();
    for (const path of ["/api/machine/acats", "/api/machine/transfer-linkage/", "/api/machine/transfer-linkage/evil/extra", "/api/machine/transfer-linkage/evil%2Fextra", "/api/machine/transfer-linkage-evil"]) {
      expect(await verifyTransferLinkageCaller(request(path), "snapshot")).toBeNull();
      expect(await verifyTransferLinkageCaller(request(path), "record")).toBeNull();
    }
    expect(await verifyTransferLinkageCaller(request(), "record")).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
  it("rejects dev identity in production even if accidentally listed", async () => {
    configure();
    process.env.TRANSFER_LINKAGE_ALLOWED_SAS = DEV_LIBRARY_SA;
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const { verifyTransferLinkageCaller } = await import("./machine-auth");
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toBeNull();
  });
  it("requires the synthetic service's own audience and explicit grant", async () => {
    configure();
    process.env.TRANSFER_LINKAGE_ENVIRONMENT = "synthetic";
    process.env.TRANSFER_LINKAGE_ALLOWED_SAS = DEV_LIBRARY_SA;
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const { verifyTransferLinkageCaller } = await import("./machine-auth");
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toBeNull();
    process.env.MACHINE_AUTH_AUDIENCE = "https://isolated-synthetic.test";
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toEqual({ email: DEV_LIBRARY_SA });
    expect(mockVerifyIdToken).toHaveBeenLastCalledWith({ idToken: "synthetic", audience: "https://isolated-synthetic.test" });
  });
  it("fails closed on unverified identity, wrong caller, invalid environment or Google rejection", async () => {
    configure();
    const { verifyTransferLinkageCaller } = await import("./machine-auth");
    for (const overrides of [{ email: "other@project.iam.gserviceaccount.com" }, { email_verified: false }]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload(overrides)));
      expect(await verifyTransferLinkageCaller(request(), "snapshot")).toBeNull();
    }
    mockVerifyIdToken.mockRejectedValue(new Error("wrong audience"));
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toBeNull();
    process.env.TRANSFER_LINKAGE_ENVIRONMENT = "unrecognized";
    expect(await verifyTransferLinkageCaller(request(), "snapshot")).toBeNull();
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", async () => {
    const { extractBearerToken } = await import("./machine-auth");
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("returns null for a missing header", async () => {
    const { extractBearerToken } = await import("./machine-auth");
    expect(extractBearerToken(null)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", async () => {
    const { extractBearerToken } = await import("./machine-auth");
    expect(extractBearerToken("Token abc")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
  });

  it("returns null for an empty bearer token", async () => {
    const { extractBearerToken } = await import("./machine-auth");
    expect(extractBearerToken("Bearer ")).toBeNull();
  });
});

describe("verifyMachineCaller", () => {
  it("does not add the scoped dev identity to the global allowlist", async () => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const { verifyMachineCaller, getAllowedServiceAccounts } = await import("./machine-auth");
    expect(getAllowedServiceAccounts()).toEqual(new Set([ALLOWED_SA]));
    expect(await verifyMachineCaller(makeRequest("Bearer t"))).toBeNull();
  });
  it("returns the caller email for a verified, allowlisted SA", async () => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload()));
    const { verifyMachineCaller } = await import("./machine-auth");

    const result = await verifyMachineCaller(makeRequest("Bearer good.token"));

    expect(result).toEqual({ email: ALLOWED_SA });
    // Verifies against the default (env-configurable) audience.
    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: "good.token",
      audience: DEFAULT_AUDIENCE,
    });
  });

  it("uses MACHINE_AUTH_AUDIENCE when set", async () => {
    process.env.MACHINE_AUTH_AUDIENCE = "https://custom.run.app";
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload()));
    const { verifyMachineCaller } = await import("./machine-auth");

    await verifyMachineCaller(makeRequest("Bearer good.token"));

    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: "good.token",
      audience: "https://custom.run.app",
    });
  });

  it("returns null when the Authorization header is missing", async () => {
    const { verifyMachineCaller } = await import("./machine-auth");
    const result = await verifyMachineCaller(makeRequest());
    expect(result).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("returns null for a malformed Authorization header", async () => {
    const { verifyMachineCaller } = await import("./machine-auth");
    const result = await verifyMachineCaller(makeRequest("garbage"));
    expect(result).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("returns null when email_verified is not true", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticketReturning(payload({ email_verified: false }))
    );
    const { verifyMachineCaller } = await import("./machine-auth");
    expect(await verifyMachineCaller(makeRequest("Bearer t"))).toBeNull();
  });

  it("returns null when the email is not in the allowlist", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticketReturning(payload({ email: "attacker@evil.iam.gserviceaccount.com" }))
    );
    const { verifyMachineCaller } = await import("./machine-auth");
    expect(await verifyMachineCaller(makeRequest("Bearer t"))).toBeNull();
  });

  it("honors a custom MACHINE_AUTH_ALLOWED_SAS list", async () => {
    process.env.MACHINE_AUTH_ALLOWED_SAS = "other@proj.iam.gserviceaccount.com";
    mockVerifyIdToken.mockResolvedValue(
      ticketReturning(payload({ email: "other@proj.iam.gserviceaccount.com" }))
    );
    const { verifyMachineCaller } = await import("./machine-auth");
    expect(await verifyMachineCaller(makeRequest("Bearer t"))).toEqual({
      email: "other@proj.iam.gserviceaccount.com",
    });
  });

  it("returns null when getPayload() yields nothing", async () => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(undefined));
    const { verifyMachineCaller } = await import("./machine-auth");
    expect(await verifyMachineCaller(makeRequest("Bearer t"))).toBeNull();
  });

  it("returns null (never throws) when verifyIdToken rejects", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("Wrong recipient - audience mismatch"));
    const { verifyMachineCaller } = await import("./machine-auth");
    await expect(verifyMachineCaller(makeRequest("Bearer t"))).resolves.toBeNull();
  });
});

describe("verifyAcatReadCaller advisor scope", () => {
  const ADVISOR_PATH = "/api/machine/advisor/acats";
  const request = (path: string, method = "GET") => {
    return new Request(`https://tracker.test${path}`, {
      method,
      headers: { authorization: "Bearer synthetic" },
    });
  };

  it("advisor list read requires the exact GET route", async () => {
    const { verifyAcatReadCaller } = await import("./machine-auth");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: ALLOWED_SA })));
    expect(await verifyAcatReadCaller(request(ADVISOR_PATH), "advisor")).toEqual({ email: ALLOWED_SA });
    mockVerifyIdToken.mockClear();
    expect(await verifyAcatReadCaller(request(ADVISOR_PATH, "POST"), "advisor")).toBeNull();
    expect(await verifyAcatReadCaller(request(`${ADVISOR_PATH}/`), "advisor")).toBeNull();
    expect(await verifyAcatReadCaller(request(`${ADVISOR_PATH}/x`), "advisor")).toBeNull();
    expect(await verifyAcatReadCaller(request("/api/machine/acats"), "advisor")).toBeNull();
    expect(await verifyAcatReadCaller(request(ADVISOR_PATH), "list")).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    markCase("machine-auth", "advisor list read requires the exact GET route");
  });

  it("advisor list read accepts the scoped dev identity", async () => {
    const { verifyAcatReadCaller } = await import("./machine-auth");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    expect(await verifyAcatReadCaller(request(ADVISOR_PATH), "advisor")).toEqual({ email: DEV_LIBRARY_SA });
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(1);
    markCase("machine-auth", "advisor list read accepts the scoped dev identity");
  });
});

describe("verifyAcatReadCaller", () => {
  const routes = [
    { route: "list", path: "/api/machine/acats" },
    { route: "clients", path: "/api/machine/clients/search" },
    { route: "transfer", path: "/api/machine/acats/synthetic" },
    { route: "record", path: "/api/machine/acats/by-record/synthetic" },
    { route: "history", path: "/api/machine/acats/by-record/synthetic/history" },
  ] as const;
  const request = (path: string, method = "GET", header = "Bearer synthetic") =>
    new Request(`https://tracker.test${path}`, { method, headers: { authorization: header } });

  it.each(routes)("allows verified dev and existing prod reads for $route", async ({ route, path }) => {
    const { verifyAcatReadCaller, getAllowedServiceAccounts, verifyMachineCaller } = await import("./machine-auth");
    for (const email of [DEV_LIBRARY_SA, ALLOWED_SA]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
      expect(await verifyAcatReadCaller(request(path), route)).toEqual({ email });
      expect(mockVerifyIdToken).toHaveBeenLastCalledWith({ idToken: "synthetic", audience: DEFAULT_AUDIENCE });
    }
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    expect(await verifyMachineCaller(request(path))).toBeNull();
    expect(getAllowedServiceAccounts()).toEqual(new Set([ALLOWED_SA]));
  });

  it.each(routes)("rejects wrong identities and unverified claims for $route", async ({ route, path }) => {
    const { verifyAcatReadCaller } = await import("./machine-auth");
    for (const email of ["other@ops-portal-dev.iam.gserviceaccount.com", `${DEV_LIBRARY_SA}.example`, "ops-portal-run@ops-portal-dev.iam.gserviceaccount.com", "synthetic@example.test", ""]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
      expect(await verifyAcatReadCaller(request(path), route)).toBeNull();
    }
    for (const email_verified of [false, undefined, "true"]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA, email_verified })));
      expect(await verifyAcatReadCaller(request(path), route)).toBeNull();
    }
    mockVerifyIdToken.mockResolvedValue(ticketReturning(undefined));
    expect(await verifyAcatReadCaller(request(path), route)).toBeNull();
  });

  it.each(routes)("normalizes verified identity and honors custom audience/allowlist for $route", async ({ route, path }) => {
    const custom = "custom@project.iam.gserviceaccount.com";
    process.env.MACHINE_AUTH_ALLOWED_SAS = custom;
    process.env.MACHINE_AUTH_AUDIENCE = "https://custom.run.app";
    const { verifyAcatReadCaller, getAllowedServiceAccounts } = await import("./machine-auth");
    for (const email of [custom, ` ${DEV_LIBRARY_SA.toUpperCase()} `, ALLOWED_SA]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
      expect(await verifyAcatReadCaller(request(path), route)).toEqual(email === ALLOWED_SA ? null : { email: email.trim().toLowerCase() });
      expect(mockVerifyIdToken).toHaveBeenLastCalledWith({ idToken: "synthetic", audience: "https://custom.run.app" });
    }
    expect(getAllowedServiceAccounts()).toEqual(new Set([custom]));
  });

  it.each(routes)("fails closed on missing/malformed tokens and Google failures for $route", async ({ route, path }) => {
    const { verifyAcatReadCaller } = await import("./machine-auth");
    for (const header of ["", "Basic synthetic", "Bearer "]) {
      expect(await verifyAcatReadCaller(request(path, "GET", header), route)).toBeNull();
    }
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    for (const reason of ["signature", "audience", "issuer", "expiry"]) {
      mockVerifyIdToken.mockRejectedValue(new Error(reason));
      await expect(verifyAcatReadCaller(request(path), route)).resolves.toBeNull();
    }
  });

  it.each(routes)("rejects mutation/other methods and mismatched routes before auth for $route", async ({ route, path }) => {
    const { verifyAcatReadCaller } = await import("./machine-auth");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(await verifyAcatReadCaller(request(path, method), route)).toBeNull();
    }
    for (const other of routes.filter((entry) => entry.route !== route)) {
      expect(await verifyAcatReadCaller(request(other.path), route)).toBeNull();
    }
    for (const path of ["/api/machine/custodians", "/api/acats", "/api/machine/acats/", "/api/machine/acats/by-record", "/api/machine/acats/by-record/", "/api/machine/acats/synthetic/extra", "/api/machine/acats/by-record/synthetic/extra", "/api/machine/acats-evil"]) {
      expect(await verifyAcatReadCaller(request(path), route)).toBeNull();
    }
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("history read requires the exact GET route", async () => {
    markCase("machine-auth-history", "history read requires the exact GET route");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const { verifyAcatReadCaller } = await import("./machine-auth");
    const path = "/api/machine/acats/by-record/synthetic/history";
    expect(await verifyAcatReadCaller(request(path), "history")).toEqual({ email: DEV_LIBRARY_SA });
    expect(await verifyAcatReadCaller(request(path, "POST"), "history")).toBeNull();
    for (const other of [`${path}/`, `${path}/extra`, "/api/machine/acats/by-record/history", "/api/machine/acats/synthetic/history"]) {
      expect(await verifyAcatReadCaller(request(other), "history")).toBeNull();
    }
    expect(await verifyAcatReadCaller(request(path), "record")).toBeNull();
    expect(await verifyAcatReadCaller(request(path), "transfer")).toBeNull();
  });

  it("accepts encoded identifiers in the existing transfer route without widening the path", async () => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const { verifyAcatReadCaller } = await import("./machine-auth");
    expect(await verifyAcatReadCaller(request("/api/machine/acats/N%2FA"), "transfer")).toEqual({ email: DEV_LIBRARY_SA });
  });

  it("cannot obtain scope from query strings or rewrite headers", async () => {
    const { verifyAcatReadCaller } = await import("./machine-auth");
    const forged = new Request("https://tracker.test/api/admin?scope=list&path=/api/machine/acats", {
      headers: { authorization: "Bearer synthetic", "x-original-url": "/api/machine/acats", "x-rewrite-url": "/api/machine/acats" },
    });
    expect(await verifyAcatReadCaller(forged, "list")).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
});

describe("verifyCustodianLibraryCaller", () => {
  const libraryRequest = (method = "GET", path = "/api/machine/custodians", header = "Bearer synthetic") =>
    new Request(`https://tracker.test${path}`, { method, headers: { authorization: header } });

  it.each([ALLOWED_SA, DEV_LIBRARY_SA])("allows verified library reads for %s", async (email) => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    expect(await verifyCustodianLibraryCaller(libraryRequest())).toEqual({ email });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic", audience: DEFAULT_AUDIENCE });
  });

  it("retains email normalization after Google verification", async () => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: ` ${DEV_LIBRARY_SA.toUpperCase()} ` })));
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    expect(await verifyCustodianLibraryCaller(libraryRequest())).toEqual({ email: DEV_LIBRARY_SA });
  });

  it.each([
    "ops-portal-run@ops-portal-dev.iam.gserviceaccount.com",
    "other@ops-portal-dev.iam.gserviceaccount.com",
    `${DEV_LIBRARY_SA}.attacker.example`, "jeremy@example.com",
  ])("rejects identities other than the exact grant: %s", async (email) => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    expect(await verifyCustodianLibraryCaller(libraryRequest())).toBeNull();
  });

  it.each([false, undefined, "true"])("rejects dev without verified email: %s", async (email_verified) => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA, email_verified })));
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    expect(await verifyCustodianLibraryCaller(libraryRequest())).toBeNull();
  });

  it.each(["signature", "audience", "issuer", "expiry"])("fails closed on Google %s rejection", async (reason) => {
    mockVerifyIdToken.mockRejectedValue(new Error(reason));
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    await expect(verifyCustodianLibraryCaller(libraryRequest())).resolves.toBeNull();
  });

  it.each(["", "Basic synthetic", "Bearer "])("rejects malformed credentials: %s", async (header) => {
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    expect(await verifyCustodianLibraryCaller(libraryRequest("GET", "/api/machine/custodians", header))).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("rejects %s before verification", async (method) => {
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    expect(await verifyCustodianLibraryCaller(libraryRequest(method))).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    "/api/machine/acats", "/api/machine/acats/synthetic",
    "/api/machine/acats/by-record/synthetic", "/api/custodians",
    "/api/machine/custodians/extra", "/api/machine/custodians-evil",
  ])("cannot be reused on a different route: %s", async (path) => {
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    expect(await verifyCustodianLibraryCaller(libraryRequest("GET", path))).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("honors the configured global audience for the library too", async () => {
    process.env.MACHINE_AUTH_AUDIENCE = "https://custom.run.app";
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const { verifyCustodianLibraryCaller } = await import("./machine-auth");
    await verifyCustodianLibraryCaller(libraryRequest());
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic", audience: "https://custom.run.app" });
  });

  it("preserves explicit global allowlist overrides without restoring removed production identities", async () => {
    const custom = "custom@project.iam.gserviceaccount.com";
    process.env.MACHINE_AUTH_ALLOWED_SAS = custom;
    const { verifyCustodianLibraryCaller, getAllowedServiceAccounts } = await import("./machine-auth");
    for (const email of [custom, DEV_LIBRARY_SA, ALLOWED_SA]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
      expect(await verifyCustodianLibraryCaller(libraryRequest())).toEqual(email === ALLOWED_SA ? null : { email });
    }
    expect(getAllowedServiceAccounts()).toEqual(new Set([custom]));
  });
});

describe("verifyAcatWriteCaller", () => {
  it("verifyAcatWriteCaller accepts an allow-listed POST create", async () => {
    markCase("machine-auth-write", "verifyAcatWriteCaller accepts an allow-listed POST create");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload()));
    const { verifyAcatWriteCaller } = await import("./machine-auth");
    const request = new Request("https://tracker.test/api/machine/acats", {
      method: "POST",
      headers: { authorization: "Bearer synthetic" },
    });
    expect(await verifyAcatWriteCaller(request, "create")).toEqual({ email: ALLOWED_SA });
  });

  it("verifyAcatWriteCaller rejects GET on the create route", async () => {
    markCase("machine-auth-write", "verifyAcatWriteCaller rejects GET on the create route");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload()));
    const { verifyAcatWriteCaller } = await import("./machine-auth");
    const request = new Request("https://tracker.test/api/machine/acats", {
      method: "GET",
      headers: { authorization: "Bearer synthetic" },
    });
    expect(await verifyAcatWriteCaller(request, "create")).toBeNull();
  });

  it("verifyAcatWriteCaller rejects the dev read service account", async () => {
    markCase("machine-auth-write", "verifyAcatWriteCaller rejects the dev read service account");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const { verifyAcatWriteCaller } = await import("./machine-auth");
    const request = new Request("https://tracker.test/api/machine/acats", {
      method: "POST",
      headers: { authorization: "Bearer synthetic" },
    });
    expect(await verifyAcatWriteCaller(request, "create")).toBeNull();
  });
});

describe("verifyDrawerCaller", () => {
  const request = (path: string, method: string, email: string) => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
    return new Request(`https://tracker.test${path}`, {
      method,
      headers: { authorization: "Bearer synthetic" },
    });
  };
  const DRAWER = "/api/machine/acats/by-record/REC-1/drawer";

  it("drawer write requires exact PATCH or DELETE route", async () => {
    markCase("machine-auth", "drawer write requires exact PATCH or DELETE route");
    const { verifyDrawerCaller } = await import("./machine-auth");
    expect(await verifyDrawerCaller(request(DRAWER, "PATCH", ALLOWED_SA), "write")).toEqual({ email: ALLOWED_SA });
    expect(await verifyDrawerCaller(request(DRAWER, "DELETE", ALLOWED_SA), "write")).toEqual({ email: ALLOWED_SA });
    expect(await verifyDrawerCaller(request(DRAWER, "GET", ALLOWED_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request(DRAWER, "POST", ALLOWED_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request(`${DRAWER}/`, "PATCH", ALLOWED_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request("/api/machine/acats/by-record/REC-1/drawer/extra", "PATCH", ALLOWED_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request("/api/machine/acats/by-record/REC%2F1/drawer", "PATCH", ALLOWED_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request(`/api/machine/acats/by-record/${"a".repeat(129)}/drawer`, "PATCH", ALLOWED_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request("/api/machine/acats/by-record/REC-1", "PATCH", ALLOWED_SA), "write")).toBeNull();
  });

  it("drawer write rejects scoped dev identity", async () => {
    markCase("machine-auth", "drawer write rejects scoped dev identity");
    const { verifyDrawerCaller } = await import("./machine-auth");
    expect(await verifyDrawerCaller(request(DRAWER, "PATCH", DEV_LIBRARY_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request(DRAWER, "DELETE", DEV_LIBRARY_SA), "write")).toBeNull();
  });

  it("drawer write requires the production identity even when the allow-list adds dev", async () => {
    markCase("machine-auth", "drawer write requires the production identity even when the allow-list adds dev");
    process.env.MACHINE_AUTH_ALLOWED_SAS = `${ALLOWED_SA},${DEV_LIBRARY_SA}`;
    const { verifyDrawerCaller } = await import("./machine-auth");
    expect(await verifyDrawerCaller(request(DRAWER, "DELETE", DEV_LIBRARY_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request(DRAWER, "PATCH", DEV_LIBRARY_SA), "write")).toBeNull();
    expect(await verifyDrawerCaller(request(DRAWER, "DELETE", ALLOWED_SA), "write")).toEqual({ email: ALLOWED_SA });
    process.env.MACHINE_AUTH_ALLOWED_SAS = "someone-else@ops-portal.iam.gserviceaccount.com";
    expect(await verifyDrawerCaller(request(DRAWER, "DELETE", ALLOWED_SA), "write")).toBeNull();
  });

  it("DTCC suggestion read accepts scoped dev identity", async () => {
    markCase("machine-auth", "DTCC suggestion read accepts scoped dev identity");
    const { verifyDrawerCaller } = await import("./machine-auth");
    const path = "/api/machine/dtcc-suggestion";
    expect(await verifyDrawerCaller(request(path, "GET", DEV_LIBRARY_SA), "suggestion")).toEqual({ email: DEV_LIBRARY_SA });
    expect(await verifyDrawerCaller(request(path, "GET", ALLOWED_SA), "suggestion")).toEqual({ email: ALLOWED_SA });
    expect(await verifyDrawerCaller(request(path, "POST", ALLOWED_SA), "suggestion")).toBeNull();
    expect(await verifyDrawerCaller(request(`${path}/`, "GET", ALLOWED_SA), "suggestion")).toBeNull();
    expect(await verifyDrawerCaller(request("/api/machine/custodians", "GET", ALLOWED_SA), "suggestion")).toBeNull();
    expect(await verifyDrawerCaller(request(path, "GET", "stranger@example.com"), "suggestion")).toBeNull();
  });
});

describe("verifyCustodianAdminCaller", () => {
  const BASE = "https://tracker.test/api/machine/custodians/admin";
  const exact: Array<[string, string, string]> = [
    ["create", "POST", BASE],
    ["update", "PATCH", `${BASE}/c1`],
    ["fee-create", "POST", `${BASE}/c1/fees`],
    ["fee-update", "PATCH", `${BASE}/c1/fees/f1`],
    ["fee-delete", "DELETE", `${BASE}/c1/fees/f1`],
    ["merge", "POST", `${BASE}/c1/merge`],
  ];
  const request = (url: string, method: string, email = ALLOWED_SA) => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
    return new Request(url, { method, headers: { authorization: "Bearer synthetic" } });
  };

  it("custodian admin verifier accepts the production SA on each exact route", async () => {
    markCase("machine-auth-custodian-admin", "custodian admin verifier accepts the production SA on each exact route");
    const { verifyCustodianAdminCaller } = await import("./machine-auth");
    for (const [route, method, url] of exact) {
      expect(
        await verifyCustodianAdminCaller(request(url, method), route as never)
      ).toEqual({ email: ALLOWED_SA });
    }
  });

  it("custodian admin verifier accepts the dev SA when MACHINE_AUTH_ALLOWED_SAS lists both", async () => {
    markCase("machine-auth-custodian-admin", "custodian admin verifier accepts the dev SA when MACHINE_AUTH_ALLOWED_SAS lists both");
    process.env.MACHINE_AUTH_ALLOWED_SAS = `${ALLOWED_SA},${DEV_LIBRARY_SA}`;
    const { verifyCustodianAdminCaller } = await import("./machine-auth");
    expect(
      await verifyCustodianAdminCaller(request(BASE, "POST", DEV_LIBRARY_SA), "create")
    ).toEqual({ email: DEV_LIBRARY_SA });
  });

  it("custodian admin verifier accepts the dev SA when MACHINE_AUTH_ALLOWED_SAS is unset", async () => {
    markCase("machine-auth-custodian-admin", "custodian admin verifier accepts the dev SA when MACHINE_AUTH_ALLOWED_SAS is unset");
    const { verifyCustodianAdminCaller } = await import("./machine-auth");
    expect(
      await verifyCustodianAdminCaller(request(BASE, "POST", DEV_LIBRARY_SA), "create")
    ).toEqual({ email: DEV_LIBRARY_SA });
  });

  it("custodian admin verifier rejects every caller when a set list omits the prod identity", async () => {
    markCase("machine-auth-custodian-admin", "custodian admin verifier rejects every caller when a set list omits the prod identity");
    process.env.MACHINE_AUTH_ALLOWED_SAS = DEV_LIBRARY_SA;
    const { verifyCustodianAdminCaller } = await import("./machine-auth");
    expect(await verifyCustodianAdminCaller(request(BASE, "POST", DEV_LIBRARY_SA), "create")).toBeNull();
    expect(await verifyCustodianAdminCaller(request(BASE, "POST", ALLOWED_SA), "create")).toBeNull();
  });

  it("custodian admin verifier rejects a wrong method or path", async () => {
    markCase("machine-auth-custodian-admin", "custodian admin verifier rejects a wrong method or path");
    const { verifyCustodianAdminCaller } = await import("./machine-auth");
    expect(await verifyCustodianAdminCaller(request(BASE, "GET"), "create")).toBeNull();
    expect(await verifyCustodianAdminCaller(request(`${BASE}/c1`, "POST"), "update")).toBeNull();
    expect(await verifyCustodianAdminCaller(request(`${BASE}/c1/fees/f1`, "PATCH"), "fee-delete")).toBeNull();
    expect(await verifyCustodianAdminCaller(request(`${BASE}/c1/merge/x`, "POST"), "merge")).toBeNull();
    expect(await verifyCustodianAdminCaller(request("https://tracker.test/api/machine/custodians", "POST"), "create")).toBeNull();
  });

  it("custodian admin verifier rejects an unverified token", async () => {
    markCase("machine-auth-custodian-admin", "custodian admin verifier rejects an unverified token");
    const { verifyCustodianAdminCaller } = await import("./machine-auth");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email_verified: false })));
    const unverified = new Request(BASE, { method: "POST", headers: { authorization: "Bearer synthetic" } });
    expect(await verifyCustodianAdminCaller(unverified, "create")).toBeNull();
    expect(await verifyCustodianAdminCaller(new Request(BASE, { method: "POST" }), "create")).toBeNull();
  });
});

describe("verifyFeeCaller", () => {
  const fees = "/api/machine/acats/by-record/synthetic/fees";

  it("fee read requires exact GET route", async () => {
    markCase("machine-auth", "fee read requires exact GET route");
    mockVerifyIdToken.mockClear();
    const { verifyFeeCaller, verifyAcatReadCaller } = await import("./machine-auth");
    const wrong = new Request("https://tracker.test/api/machine/acats/by-record/synthetic/fees/extra", {
      method: "GET",
      headers: { authorization: "Bearer synthetic" },
    });
    expect(await verifyFeeCaller(wrong, "read")).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    const record = new Request(`https://tracker.test${fees}`, {
      method: "GET",
      headers: { authorization: "Bearer synthetic" },
    });
    expect(await verifyAcatReadCaller(record, "record")).toBeNull();
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload()));
    expect(await verifyFeeCaller(record, "read")).toEqual({ email: ALLOWED_SA });
    expect(await verifyFeeCaller(new Request(`https://tracker.test${fees}`, { method: "POST", headers: { authorization: "Bearer synthetic" } }), "read")).toBeNull();
  });

  it("fee write requires exact POST route", async () => {
    markCase("machine-auth", "fee write requires exact POST route");
    const { verifyFeeCaller } = await import("./machine-auth");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload()));
    const post = new Request(`https://tracker.test${fees}`, { method: "POST", headers: { authorization: "Bearer synthetic" } });
    expect(await verifyFeeCaller(post, "write")).toEqual({ email: ALLOWED_SA });
    const get = new Request(`https://tracker.test${fees}`, { method: "GET", headers: { authorization: "Bearer synthetic" } });
    expect(await verifyFeeCaller(get, "write")).toBeNull();
  });

  it("fee read accepts the dev identity when the allow-list includes it", async () => {
    markCase("machine-auth", "fee read accepts the dev identity when the allow-list includes it");
    process.env.MACHINE_AUTH_ALLOWED_SAS = `${ALLOWED_SA},${DEV_LIBRARY_SA}`;
    const { verifyFeeCaller } = await import("./machine-auth");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const request = new Request(`https://tracker.test${fees}`, { method: "GET", headers: { authorization: "Bearer synthetic" } });
    expect(await verifyFeeCaller(request, "read")).toEqual({ email: DEV_LIBRARY_SA });
  });

  it("fee write rejects the dev identity when the allow-list omits it", async () => {
    markCase("machine-auth", "fee write rejects the dev identity when the allow-list omits it");
    const { verifyFeeCaller } = await import("./machine-auth");
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA })));
    const request = new Request(`https://tracker.test${fees}`, { method: "POST", headers: { authorization: "Bearer synthetic" } });
    expect(await verifyFeeCaller(request, "write")).toBeNull();
  });
});

describe("verifyCustodianSnapshotCaller", () => {
  const snap = (method = "GET", path = "/api/machine/custodians/snapshot", header = "Bearer synthetic") =>
    new Request(`https://tracker.test${path}`, { method, headers: { authorization: header } });

  it("allows the production and dev readers on the exact snapshot GET", async () => {
    for (const email of [ALLOWED_SA, DEV_LIBRARY_SA]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
      const { verifyCustodianSnapshotCaller } = await import("./machine-auth");
      expect(await verifyCustodianSnapshotCaller(snap(), "snapshot")).toEqual({ email });
    }
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic", audience: DEFAULT_AUDIENCE });
  });

  it("allows the production and dev readers on the exact file GET", async () => {
    for (const email of [ALLOWED_SA, DEV_LIBRARY_SA]) {
      mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email })));
      const { verifyCustodianSnapshotCaller } = await import("./machine-auth");
      expect(await verifyCustodianSnapshotCaller(
        snap("GET", "/api/machine/custodians/fee-schedules/doc_1"),
        "file",
      )).toEqual({ email });
    }
  });

  it("rejects other methods, paths, and query scope before verification", async () => {
    const { verifyCustodianSnapshotCaller, verifyCustodianLibraryCaller } = await import("./machine-auth");
    const denied = [
      snap("POST"),
      snap("GET", "/api/machine/custodians"),
      snap("GET", "/api/machine/custodians/snapshot/extra"),
      snap("GET", "/api/machine/custodians/fee-schedules"),
      snap("GET", "/api/machine/custodians/fee-schedules/doc_1/extra"),
      new Request("https://tracker.test/api/machine/custodians?route=snapshot", {
        headers: { authorization: "Bearer synthetic", "x-original-url": "/api/machine/custodians/snapshot" },
      }),
    ];
    for (const request of denied) {
      expect(await verifyCustodianSnapshotCaller(request, "snapshot")).toBeNull();
      expect(await verifyCustodianSnapshotCaller(request, "file")).toBeNull();
    }
    expect(await verifyCustodianLibraryCaller(snap())).toBeNull();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects an unverified or unlisted caller", async () => {
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: DEV_LIBRARY_SA, email_verified: false })));
    const { verifyCustodianSnapshotCaller } = await import("./machine-auth");
    expect(await verifyCustodianSnapshotCaller(snap(), "snapshot")).toBeNull();
    mockVerifyIdToken.mockResolvedValue(ticketReturning(payload({ email: "outsider@example.com" })));
    expect(await verifyCustodianSnapshotCaller(snap(), "snapshot")).toBeNull();
  });

  it("fails closed when Google rejects the token", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("signature"));
    const { verifyCustodianSnapshotCaller } = await import("./machine-auth");
    await expect(verifyCustodianSnapshotCaller(snap(), "snapshot")).resolves.toBeNull();
  });
});
