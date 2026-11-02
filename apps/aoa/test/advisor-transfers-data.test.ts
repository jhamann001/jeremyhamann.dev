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

import { readAdvisorTransfers } from "@/lib/data/advisor-transfers";
import { ADVISOR_TRANSFER_KEYS } from "@/lib/transfers/advisor-transfer-status";

const SUITE = "advisor-transfers-data";
const AUDIENCE = "https://transfers.jeremyhamann.dev";
const WORK_EMAIL = "advisor@example.com";

// A row shaped like the tracker's redacted AdvisorAcatRecord (tracker 25555c2).
function trackerRow(over: Record<string, unknown> = {}) {
  return {
    id: "REC-001",
    clientName: "Abigayle Beier",
    status: "Submitted",
    direction: "In",
    type: "Full",
    accountType: "Traditional IRA",
    transferringContra: "Charles Schwab",
    wealthAdvisor: "Rachel",
    additionalResources: "https://app.crm.example/tasks/abc-123",
    originalClientRequestDate: "2026-04-01",
    opsSubmissionDateToApex: "2026-04-03",
    apexCompletionDate: null,
    acatDate: "2026-04-01",
    statementAmount: 123456789,
    custodian: { id: "C1", name: "Charles Schwab", avgProcessingDays: 6 },
    ...over,
  };
}

function enable() {
  vi.stubEnv("EPIC_ACAT_ADVISOR_LIST_TKT324", "1");
  vi.stubEnv("SHOW_ACAT_ADVISOR_LIST_TKT338", "1");
}

describe("advisor transfers tracker reader", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    enable();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the redacted rows for an allowed person and sends the work email header", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { acats: [trackerRow()] } });
    const result = await readAdvisorTransfers("  Advisor@example.com ");
    expect(result).toEqual({ ok: true, rows: [trackerRow()] });
    expect(getIdTokenClientMock).toHaveBeenCalledWith(AUDIENCE);
    const options = requestMock.mock.calls[0][0];
    expect(options.method).toBe("GET");
    expect(options.url).toBe(`${AUDIENCE}/api/machine/advisor/acats`);
    expect(options.headers).toEqual({ "Cache-Control": "no-store", "X-Aoa-Actor-Email": WORK_EMAIL });
    expect(options.timeout).toBe(10_000);
    expect(options.retry).toBe(false);
    requestMock.mockResolvedValue({ status: 200, data: { acats: [] } });
    expect(await readAdvisorTransfers(WORK_EMAIL)).toEqual({ ok: true, rows: [] });
    markCase(SUITE, "returns the redacted rows for an allowed person and sends the work email header");
  });

  it("keeps only whitelisted columns and drops fee or note fields", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      data: {
        acats: [trackerRow({
          apexAccountId: "TAV-vgthyr-823",
          statementAccountNumber: "FQBU-lsqsxd-612",
          controlNumber: "CTRL-secret-001",
          feeAmount: "$75.00",
          feeMemo: "internal-only fee context",
          notes: "internal-only ops notes",
          custodian: { id: "C1", name: "Charles Schwab", avgProcessingDays: 6, acatFeeAmount: 50, contactEmail: "ops@schwab.example" },
        })],
      },
    });
    const result = await readAdvisorTransfers(WORK_EMAIL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.rows[0]).sort()).toEqual([...ADVISOR_TRANSFER_KEYS].sort());
    const text = JSON.stringify(result.rows);
    for (const secret of ["TAV-vgthyr-823", "FQBU-lsqsxd-612", "CTRL-secret-001", "$75.00", "internal-only fee context", "internal-only ops notes", "ops@schwab.example", "acatFeeAmount"]) {
      expect(text).not.toContain(secret);
    }
    markCase(SUITE, "keeps only whitelisted columns and drops fee or note fields");
  });

  it("maps the tracker refusal to not_allowed and other failures to retryable", async () => {
    requestMock.mockResolvedValueOnce({ status: 403, data: { error: "not_allowed" } });
    expect(await readAdvisorTransfers(WORK_EMAIL)).toEqual({ ok: false, reason: "not_allowed" });
    const unavailable = [
      [403, { error: "forbidden" }],
      [403, "<html>blocked</html>"],
      [401, { error: "unauthorized" }],
      [404, { error: "not_found" }],
      [400, { error: "invalid_request" }],
      [429, { error: "rate_limited" }],
      [500, { error: "internal_error" }],
    ] as const;
    for (const [status, data] of unavailable) {
      requestMock.mockResolvedValueOnce({ status, data });
      expect(await readAdvisorTransfers(WORK_EMAIL)).toEqual({ ok: false, reason: "unavailable" });
    }
    requestMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await readAdvisorTransfers(WORK_EMAIL)).toEqual({ ok: false, reason: "unavailable" });
    // A blank work email is refused locally with no tracker call.
    requestMock.mockClear();
    getIdTokenClientMock.mockClear();
    expect(await readAdvisorTransfers("   ")).toEqual({ ok: false, reason: "not_allowed" });
    expect(requestMock).not.toHaveBeenCalled();
    // A tracker that never answers is abandoned after 10 s and is retryable.
    vi.useFakeTimers();
    try {
      requestMock.mockImplementationOnce(() => new Promise(() => {}));
      const pending = readAdvisorTransfers(WORK_EMAIL);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
    markCase(SUITE, "maps the tracker refusal to not_allowed and other failures to retryable");
  });

  it("fails closed while the advisor list flags are off", async () => {
    for (const [epic, show] of [["0", "1"], ["1", "0"], ["", ""]]) {
      vi.stubEnv("EPIC_ACAT_ADVISOR_LIST_TKT324", epic);
      vi.stubEnv("SHOW_ACAT_ADVISOR_LIST_TKT338", show);
      expect(await readAdvisorTransfers(WORK_EMAIL)).toEqual({ ok: false, reason: "disabled" });
    }
    expect(requestMock).not.toHaveBeenCalled();
    expect(getIdTokenClientMock).not.toHaveBeenCalled();
    markCase(SUITE, "fails closed while the advisor list flags are off");
  });

  it("treats a malformed payload as retryable", async () => {
    const bad: unknown[] = [
      null,
      { acats: "nope" },
      { rows: [] },
      { acats: [{ id: "x" }] },
      { acats: [trackerRow({ statementAmount: "12" })] },
      { acats: [trackerRow({ custodian: { id: "C1" } })] },
      { acats: [trackerRow({ direction: undefined })] },
      // One bad element among valid ones fails the whole list.
      { acats: [trackerRow(), trackerRow({ id: "REC-002", acatDate: 5 })] },
    ];
    for (const data of bad) {
      requestMock.mockResolvedValueOnce({ status: 200, data });
      expect(await readAdvisorTransfers(WORK_EMAIL)).toEqual({ ok: false, reason: "unavailable" });
    }
    // Contract drift is logged by name only, never with the body.
    expect(vi.mocked(console.error)).toHaveBeenCalledWith("[advisor-transfers] malformed_payload");
    markCase(SUITE, "treats a malformed payload as retryable");
  });

  it("never logs the work email", async () => {
    const spy = vi.mocked(console.error);
    requestMock.mockResolvedValueOnce({ status: 403, data: { error: "not_allowed" } });
    await readAdvisorTransfers(WORK_EMAIL);
    requestMock.mockResolvedValueOnce({ status: 500, data: { error: `boom ${WORK_EMAIL}` } });
    await readAdvisorTransfers(WORK_EMAIL);
    requestMock.mockRejectedValueOnce(new Error(`lookup failed for ${WORK_EMAIL}`));
    await readAdvisorTransfers(WORK_EMAIL);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(WORK_EMAIL);
    markCase(SUITE, "never logs the work email");
  });
});
