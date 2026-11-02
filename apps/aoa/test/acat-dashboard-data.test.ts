import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import { postAcatDashboardReview, readAcatDashboard, type AcatDashboard } from "@/lib/data/acat-dashboard";

const SUITE = "acat-dashboard-data";
const AUDIENCE = "https://transfers.jeremyhamann.dev";
const distribution = {
  average: 1, median: 2, p75: 3, p90: 4, sampleSize: 5,
};
const reviewBody = {
  acatRecordId: "rec-1",
  ruleKey: "completed_missing_date",
  fingerprint: "fingerprint",
  status: "CLOSED" as const,
  resolution: "FALSE_POSITIVE" as const,
  note: null,
};

function contract(): AcatDashboard {
  return {
    summary: {
      total: 40, Completed: 9, Rejected: 3, Canceled: 2, Purged: 8, active: 25, validFinalized: 14,
      completedRate: 0.5, rejectionRate: 0.25, canceledRate: 0.125,
    },
    workflowTimings: [{
      workflow: "ACAT",
      requestToSubmit: distribution,
      submitToComplete: distribution,
      requestToComplete: distribution,
    }],
    monthlyVolume: [{
      month: "2025-06",
      label: "Jun 2025",
      total: 4,
      workflows: { ACAT: 1, MANUAL: 1, DRS: 1, RESIDUAL: 0, UNCLASSIFIED: 1 },
    }],
    flow: {
      incoming: { totalCount: 2, totalAmount: 10, requestedCount: 1, requestedAmount: 8, residualCount: 1, residualAmount: 2 },
      outgoing: { totalCount: 1, totalAmount: 4, requestedCount: 1, requestedAmount: 4, residualCount: 0, residualAmount: 0 },
      netAmount: 1234.5,
      requestedNetAmount: 4,
      residualNetAmount: 2,
    },
    topContras: {
      acat: [{ contra: "Fidelity", completed: 2, finalized: 3, rejectionRate: 0.1, medianApexDays: 4, completedAmount: 20 }],
      manual: [],
    },
    residuals: {
      queue: [{ record: { id: "rec-queue", clientName: "Queue Client", transferringContra: "Fidelity" }, followUpDate: "2026-01-01", daysPastFollowUp: 3 }],
      benchmarks: [{ contra: "Fidelity", sampleSize: 4, medianDays: 10, p75Days: 12, p90Days: null }],
    },
    quality: {
      rules: [{ ruleKey: "completed_missing_date", title: "Completed without Apex date", description: "Completed transfers must have an Apex Completion Date." }],
      exceptions: [{
        record: { id: "rec-ada", clientName: "Daniel Chen", transferringContra: "Fidelity" },
        ruleKey: "completed_missing_date",
        fingerprint: "fingerprint",
        title: "Completed without Apex date",
        detail: "Missing date",
        severity: "high",
        review: null,
      }],
    },
    reconciliation: {
      coverageRate: 0.5, tracked: 2, eligible: 4, matched: 1, matchRate: null, mismatch: 1, pending: 0, notTracked: 2,
    },
  };
}

function enable() {
  vi.stubEnv("APP_ENV", "dev");
  vi.stubEnv("OPERATIONS_TOOLS", "1");
  vi.stubEnv("EPIC_ACAT_TRANSFER_DASHBOARD_TKT314", "1");
  vi.stubEnv("SHOW_ACAT_TRANSFER_DASHBOARD_TKT314", "1");
}

describe("ACAT dashboard machine adapter", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
    enable();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the ticket dashboard response", async () => {
    const dashboard = contract();
    requestMock.mockResolvedValue({ status: 200, data: dashboard });
    expect(await readAcatDashboard()).toEqual({ ok: true, dashboard });
    expect(getIdTokenClientMock).toHaveBeenCalledWith(AUDIENCE);
    const options = requestMock.mock.calls[0][0];
    expect(options.method).toBe("GET");
    expect(options.url).toBe(`${AUDIENCE}/api/machine/dashboard`);
    expect(options.timeout).toBe(10_000);
    expect(options.headers).toEqual({ "Cache-Control": "no-store" });
    expect(options.retry).toBe(false);
    markCase(SUITE, "accepts the ticket dashboard response");
  });

  it("maps unauthorized dashboard reads", async () => {
    for (const status of [401, 403]) {
      requestMock.mockResolvedValueOnce({ status, data: { error: "unauthorized" } });
      expect(await readAcatDashboard()).toEqual({ ok: false, retryable: false, reason: "unauthorized" });
    }
    markCase(SUITE, "maps unauthorized dashboard reads");
  });

  it("maps unavailable and malformed dashboard reads to retry", async () => {
    vi.stubEnv("SHOW_ACAT_TRANSFER_DASHBOARD_TKT314", "0");
    expect(await readAcatDashboard()).toEqual({ ok: false, retryable: true, reason: "not_found" });
    expect(requestMock).not.toHaveBeenCalled();
    enable();
    const cases: Array<[number, unknown, string]> = [
      [404, { error: "not_found" }, "not_found"],
      [429, { error: "rate_limited" }, "rate_limited"],
      [500, { error: "internal_error" }, "internal_error"],
      [200, { summary: { total: 0 } }, "malformed"],
    ];
    for (const [status, data, reason] of cases) {
      requestMock.mockResolvedValueOnce({ status, data });
      const result = await readAcatDashboard();
      expect(result).toEqual({ ok: false, retryable: true, reason });
      expect(result).not.toHaveProperty("dashboard");
    }
    markCase(SUITE, "maps unavailable and malformed dashboard reads to retry");
  });

  it("maps transport failure without synthetic zeroes", async () => {
    requestMock.mockRejectedValue(new Error("synthetic transport failure"));
    const result = await readAcatDashboard();
    expect(result).toEqual({ ok: false, retryable: true, reason: "transport_error" });
    expect(JSON.stringify(result)).not.toContain('"total":0');
    expect(result).not.toHaveProperty("dashboard");
    markCase(SUITE, "maps transport failure without synthetic zeroes");
  });

  it("posts the ticket review body", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { status: "CLOSED", resolution: "FALSE_POSITIVE", note: null } });
    expect(await postAcatDashboardReview(reviewBody)).toEqual({
      ok: true,
      review: { status: "CLOSED", resolution: "FALSE_POSITIVE", note: null },
    });
    const options = requestMock.mock.calls[0][0];
    expect(options.method).toBe("POST");
    expect(options.url).toBe(`${AUDIENCE}/api/machine/dashboard/reviews`);
    expect(options.data).toEqual(reviewBody);
    expect(options.data).not.toHaveProperty("clientName");
    expect(options.timeout).toBe(10_000);
    expect(options.headers).toEqual({ "Cache-Control": "no-store" });
    markCase(SUITE, "posts the ticket review body");
  });

  it("keeps rejected review writes open with the tracker error", async () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { error: "note: A note is required for this resolution" }, "note: A note is required for this resolution"],
      [401, { error: "unauthorized" }, "unauthorized"],
      [404, { error: "not_found" }, "not_found"],
      [404, { error: "transfer_not_found" }, "transfer_not_found"],
      [429, { error: "rate_limited" }, "rate_limited"],
      [500, { error: "internal_error" }, "internal_error"],
      [200, { id: "review-1" }, "malformed"],
    ];
    for (const [status, data, reason] of cases) {
      requestMock.mockResolvedValueOnce({ status, data });
      expect(await postAcatDashboardReview(reviewBody)).toEqual({ ok: false, open: true, reason });
    }
    requestMock.mockRejectedValueOnce(new Error("synthetic transport failure"));
    expect(await postAcatDashboardReview(reviewBody)).toEqual({ ok: false, open: true, reason: "transport_error" });
    markCase(SUITE, "keeps rejected review writes open with the tracker error");
  });
});
