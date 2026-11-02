import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { authMock, readMock, notFoundMock, redirectMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  readMock: vi.fn(),
  notFoundMock: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirectMock: vi.fn(() => { throw new Error("REDIRECT"); }),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("next/navigation", () => ({ notFound: notFoundMock, redirect: redirectMock }));
vi.mock("@/lib/data/advisor-transfers", () => ({ readAdvisorTransfers: readMock }));

import ClientTransfersPage from "@/app/(authenticated)/client-transfers/page";
import { loadAdvisorTransfers } from "@/app/(authenticated)/client-transfers/actions";
import { AdvisorTransferList } from "@/components/transfers/AdvisorTransferList";

const SUITE = "client-transfers-page";
const EMAIL = "advisor@example.com";
const ROW = {
  id: "r1", clientName: "Abigayle Beier", status: "Submitted", direction: "In", type: "Full", accountType: null,
  transferringContra: "Charles Schwab", wealthAdvisor: "Rachel", additionalResources: null,
  originalClientRequestDate: null, opsSubmissionDateToApex: null, apexCompletionDate: null,
  acatDate: "2026-04-01", statementAmount: null, custodian: null,
};

function flags(epic: string, show: string) {
  vi.stubEnv("EPIC_ACAT_ADVISOR_LIST_TKT324", epic);
  vi.stubEnv("SHOW_ACAT_ADVISOR_LIST_TKT338", show);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  flags("1", "1");
  authMock.mockResolvedValue({ user: { email: EMAIL, role: "VIEWER" } });
});

describe("Client Transfers page", () => {
  it("redirects an unauthenticated visitor", async () => {
    authMock.mockResolvedValue(null);
    await expect(ClientTransfersPage()).rejects.toThrow("REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(readMock).not.toHaveBeenCalled();
    markCase(SUITE, "redirects an unauthenticated visitor");
  });

  it("returns not found while either advisor list flag is off without calling the tracker", async () => {
    for (const [epic, show] of [["0", "1"], ["1", "0"], ["", ""]]) {
      flags(epic, show);
      await expect(ClientTransfersPage()).rejects.toThrow("NOT_FOUND");
    }
    expect(readMock).not.toHaveBeenCalled();
    markCase(SUITE, "returns not found while either advisor list flag is off without calling the tracker");
  });

  it("returns not found for a person the tracker refuses", async () => {
    readMock.mockResolvedValue({ ok: false, reason: "not_allowed" });
    await expect(ClientTransfersPage()).rejects.toThrow("NOT_FOUND");
    expect(readMock).toHaveBeenCalledWith(EMAIL);
    authMock.mockResolvedValue({ user: {} });
    await expect(ClientTransfersPage()).rejects.toThrow("NOT_FOUND");
    expect(readMock).toHaveBeenCalledTimes(1);
    markCase(SUITE, "returns not found for a person the tracker refuses");
  });

  it("renders the list for an allowed person", async () => {
    readMock.mockResolvedValue({ ok: true, rows: [ROW] });
    const element = (await ClientTransfersPage()) as { type: unknown; props: { initial: unknown } };
    expect(element.type).toBe(AdvisorTransferList);
    expect(element.props.initial).toEqual({ ok: true, rows: [ROW] });
    markCase(SUITE, "renders the list for an allowed person");
  });

  it("renders the retryable failure when the tracker is unavailable", async () => {
    readMock.mockResolvedValue({ ok: false, reason: "unavailable" });
    const element = (await ClientTransfersPage()) as { type: unknown; props: { initial: unknown } };
    expect(element.type).toBe(AdvisorTransferList);
    expect(element.props.initial).toEqual({ ok: false });
    markCase(SUITE, "renders the retryable failure when the tracker is unavailable");
  });

  it("refuses the load action without a session email or while the flag is off", async () => {
    authMock.mockResolvedValue(null);
    expect(await loadAdvisorTransfers()).toEqual({ ok: false, reason: "not_allowed" });
    authMock.mockResolvedValue({ user: {} });
    expect(await loadAdvisorTransfers()).toEqual({ ok: false, reason: "not_allowed" });
    flags("1", "0");
    authMock.mockResolvedValue({ user: { email: EMAIL } });
    expect(await loadAdvisorTransfers()).toEqual({ ok: false, reason: "not_allowed" });
    expect(readMock).not.toHaveBeenCalled();
    flags("1", "1");
    readMock.mockResolvedValue({ ok: true, rows: [ROW] });
    expect(await loadAdvisorTransfers()).toEqual({ ok: true, rows: [ROW] });
    expect(readMock).toHaveBeenCalledWith(EMAIL);
    readMock.mockResolvedValue({ ok: false, reason: "unavailable" });
    expect(await loadAdvisorTransfers()).toEqual({ ok: false, reason: "unavailable" });
    readMock.mockResolvedValue({ ok: false, reason: "not_allowed" });
    expect(await loadAdvisorTransfers()).toEqual({ ok: false, reason: "not_allowed" });
    markCase(SUITE, "refuses the load action without a session email or while the flag is off");
  });
});
