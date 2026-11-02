import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryRawUnsafe, queryRaw, sendSpy } = vi.hoisted(() => ({ queryRawUnsafe: vi.fn(), queryRaw: vi.fn(), sendSpy: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $queryRawUnsafe: queryRawUnsafe, $queryRaw: queryRaw } }));
vi.mock("@/lib/slack/trade-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slack/trade-requests")>()),
  sendTradeRequestSlack: sendSpy,
}));

import {
  AOA_DIGEST_LINKS, DIGEST_QUEUE_SQL, OPEN_STATUSES, computeRunDate, digestClaimSummary, renderDigest, runDailyDigest,
  summarizeDigestRows, type DigestRow,
} from "@/lib/trade-requests/native/digest";
import { tradeRequestsDigestJobEnabled } from "@/lib/flags";
import { CASES } from "../scripts/trade-requests/digest-fixture-cases.mjs";

const now = new Date(CASES.mixed.now);
const rows = () => structuredClone(CASES.mixed.rows) as unknown as DigestRow[];

beforeEach(() => {
  vi.resetAllMocks();
  queryRawUnsafe.mockResolvedValue(rows());
  queryRaw.mockResolvedValue([{ run_date: "2026-10-19" }]);
  sendSpy.mockResolvedValue({ status: "sent" });
});
afterEach(() => vi.unstubAllEnvs());

describe("Trade Request weekday digest", () => {
  it("computes the run date in America/New_York", () => {
    expect(computeRunDate(new Date("2026-10-20T03:30:00.000Z"))).toBe("2026-10-19");
    expect(computeRunDate(new Date("2026-03-08T07:30:00.000Z"))).toBe("2026-03-08");
    expect(computeRunDate(new Date("2026-11-01T04:30:00.000Z"))).toBe("2026-11-01");
  });
  it("reads the queue, claims the date with the standalone summary, then posts the digest once to the channel", async () => {
    const result = await runDailyDigest(now);
    const summary = summarizeDigestRows(rows(), now);
    expect(result).toEqual({ sent: true, runDate: "2026-10-19", counts: { total: 8, urgent: 2, overdue48h: 2 } });
    expect(queryRawUnsafe).toHaveBeenCalledWith(DIGEST_QUEUE_SQL, [...OPEN_STATUSES]);
    const [strings, ...values] = queryRaw.mock.calls[0];
    expect((strings as string[]).join("?")).toContain("INSERT INTO trade_request.digest_runs (run_date, summary)");
    expect((strings as string[]).join("?")).toContain("ON CONFLICT (run_date) DO NOTHING");
    expect(values).toEqual(["2026-10-19", '{"total":8,"urgent":2,"overdue48h":2}']);
    expect(digestClaimSummary(summary)).toBe(values[1]);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("channel", renderDigest(summary, now, AOA_DIGEST_LINKS));
    expect(sendSpy.mock.calls[0][1]).toContain("<https://aoa.jeremyhamann.dev/trade-requests/queue|Open the queue →>");
  });
  it("returns already posted without posting when the run date is claimed", async () => {
    queryRaw.mockResolvedValue([]);
    expect(await runDailyDigest(now)).toEqual({ sent: false, reason: "already_posted", runDate: "2026-10-19", counts: { total: 8, urgent: 2, overdue48h: 2 } });
    expect(sendSpy).not.toHaveBeenCalled();
  });
  it("records a failed post in the run result after one attempt", async () => {
    sendSpy.mockResolvedValue({ status: "failed", code: "channel_not_found" });
    expect(await runDailyDigest(now)).toEqual({ sent: false, reason: "post_failed", code: "channel_not_found", runDate: "2026-10-19", counts: { total: 8, urgent: 2, overdue48h: 2 } });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
  it("treats an unconfigured or disabled Slack sender as not sent", async () => {
    sendSpy.mockResolvedValue({ status: "skipped" });
    expect(await runDailyDigest(now)).toMatchObject({ sent: false, reason: "slack_skipped" });
  });
  it("claims before it posts", async () => {
    await runDailyDigest(now);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(sendSpy.mock.invocationCallOrder[0]);
  });
  it("logs only the date, the outcome and the count", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await runDailyDigest(now);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("trade_request_digest");
    expect(logged).not.toContain("REQ-");
    expect(logged).not.toContain("Sample");
    expect(logged).not.toContain("Pat");
    info.mockRestore();
  });
  it("names every catalog table with the trade_request schema", () => {
    const source = readFileSync("lib/trade-requests/native/digest.ts", "utf8");
    for (const table of ["users", "clients", "accounts", "trade_requests", "audit_logs", "notifications", "client_exclusions", "account_exclusions", "digest_runs", "registry_drift_runs", "position_drift_accounts", "drift_alert_sends", "drift_status_overrides", "security_sector"]) {
      expect(source).not.toMatch(new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, "i"));
    }
    for (const qualified of ["FROM trade_request.trade_requests", "JOIN trade_request.users", "INTO trade_request.digest_runs"]) {
      expect(source).toContain(qualified);
    }
  });
  it("turns the digest switch on only with the epic master and an exact 1", () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_DIGEST_JOB", "1");
    expect(tradeRequestsDigestJobEnabled()).toBe(true);
  });
  it("keeps the digest switch off without the epic master", () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "");
    vi.stubEnv("TRADE_REQUESTS_DIGEST_JOB", "1");
    expect(tradeRequestsDigestJobEnabled()).toBe(false);
  });
  it("keeps the digest switch off for values other than 1", () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_DIGEST_JOB", "true");
    expect(tradeRequestsDigestJobEnabled()).toBe(false);
  });
});
