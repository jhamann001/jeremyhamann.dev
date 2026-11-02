// AOA Trade Request side effects (ticket): serving-state gate, bells for eligible roster members and submitters,
// one Slack attempt per message, and failures that never reach the caller. Prisma, the serving state, the roster
// and Slack (fetch) are all stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeRawMock = vi.hoisted(() => vi.fn());
const servingMock = vi.hoisted(() => vi.fn());
const eligibleMock = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $executeRaw: executeRawMock } }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ readServingState: servingMock }));
vi.mock("@/lib/trade-requests/roster", () => ({ eligibleRecipientIds: eligibleMock }));

import { emitTradeRequestEvent, type TradeRequestEvent } from "@/lib/trade-requests/native/side-effects";

const TOKEN = "xoxb-000000000-synthetic";
const served = (source: "aoa" | "standalone") => ({ servingSource: source, digestSender: "standalone", driftSender: "standalone" });

const SUBMITTED: TradeRequestEvent = {
  kind: "submitted",
  request: { requestId: "REQ-00000001", clientName: "Sample", tradeType: "Rebalance", priority: "Standard", submittedBy: "Pat Advisor", totalValue: 100, accounts: ["ACCT-1"] },
};
const RESUBMITTED: TradeRequestEvent = { kind: "resubmitted", requestId: "REQ-00000001", clientName: "Sample", changedBy: "Pat Advisor" };
const STATUS = (submitterSlackId: string | null): TradeRequestEvent => ({
  kind: "status_changed", requestId: "REQ-00000001", clientName: "Sample", newStatus: "Approved", note: "ok", changedBy: "Tia Trader",
  submitterId: "sub-1", submitterSlackId,
});
const EXCLUSION: TradeRequestEvent = {
  kind: "exclusion_changed",
  change: { clientName: "Sample", ticker: "TSLA", kind: "client", reason: "", noBuy: true, noSell: false, action: "added", changedBy: "Pat Advisor" },
};
const BATCH = (n: number): TradeRequestEvent => ({
  kind: "exclusion_batch_changed",
  batch: {
    clientName: "Sample",
    added: Array.from({ length: n }, (_, i) => ({ ticker: `T${i}`, kind: "client" as const, reason: "", noBuy: true, noSell: false })),
    removed: [],
    changed: [],
    changedBy: "Pat Advisor",
  },
});
const ALL_EVENTS = [SUBMITTED, RESUBMITTED, STATUS("U0WKHNENF9"), STATUS(null), EXCLUSION, BATCH(2)];

/** The values bound into each `$executeRaw` tagged-template call: [body, requestId, userIds]. */
const inserts = () => executeRawMock.mock.calls.map((call) => call.slice(1) as [string, string | null, string[]]);
const posts = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as { channel: string; text: string });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeRawMock.mockReset().mockResolvedValue(1);
  servingMock.mockReset().mockResolvedValue(served("aoa"));
  eligibleMock.mockReset().mockResolvedValue(["id-a", "id-b"]);
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
  vi.stubEnv("TRADE_REQUESTS_SLACK", "");
  vi.stubEnv("TRADE_REQUEST_SLACK_BOT_TOKEN", TOKEN);
  vi.stubEnv("TRADE_REQUEST_SLACK_CHANNEL_ID", "CFIXTURE");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("emitTradeRequestEvent", () => {
  it("does nothing for any event while standalone-served", async () => {
    servingMock.mockResolvedValue(served("standalone"));
    for (const event of ALL_EVENTS) await emitTradeRequestEvent(event);
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submitted: one bell insert for every eligible member and one channel post", async () => {
    await emitTradeRequestEvent(SUBMITTED);
    expect(inserts()).toEqual([["New trade request REQ-00000001 submitted for Sample", "REQ-00000001", ["id-a", "id-b"]]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/chat.postMessage");
    expect(posts(fetchMock)[0].channel).toBe("CFIXTURE");
    expect(posts(fetchMock)[0].text).toContain("View request: https://aoa.jeremyhamann.dev/trade-requests/queue/REQ-00000001");
  });

  it("submitted with no eligible member: no insert, Slack still posted once", async () => {
    eligibleMock.mockResolvedValue([]);
    await emitTradeRequestEvent(SUBMITTED);
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("status_changed with a Slack ID: one direct message and one bell for the submitter only", async () => {
    await emitTradeRequestEvent(STATUS("U0WKHNENF9"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts(fetchMock)[0].channel).toBe("U0WKHNENF9");
    expect(inserts()).toEqual([["Trade request REQ-00000001 status updated to: Approved", "REQ-00000001", ["sub-1"]]]);
    expect(eligibleMock).not.toHaveBeenCalled();
  });

  it("status_changed without a Slack ID: one post to the channel", async () => {
    await emitTradeRequestEvent(STATUS(null));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts(fetchMock)[0].channel).toBe("CFIXTURE");
  });

  it("resubmitted: one channel post with Pending Review and the resubmission note, bells to eligible members", async () => {
    await emitTradeRequestEvent(RESUBMITTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [post] = posts(fetchMock);
    expect(post.channel).toBe("CFIXTURE");
    expect(post.text).toContain("updated to: *Pending Review*");
    expect(post.text).toContain("Note: Advisor resubmitted request with updates.");
    expect(inserts()).toEqual([["Trade request REQ-00000001 resubmitted for Sample", "REQ-00000001", ["id-a", "id-b"]]]);
  });

  it("exclusion_changed: one post and one bell insert with no request id", async () => {
    await emitTradeRequestEvent(EXCLUSION);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inserts()).toEqual([["Exclusion added for Sample: TSLA (client, DNB)", null, ["id-a", "id-b"]]]);
  });

  it("exclusion_batch_changed with an empty batch: nothing", async () => {
    await emitTradeRequestEvent(BATCH(0));
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Slack timeout resolves, still inserts the bells and logs only the code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(emitTradeRequestEvent(SUBMITTED)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('\\"code\\":\\"timeout\\"');
    expect(logged).not.toContain("New Trade Request");
    expect(logged).not.toContain("CFIXTURE");
  });

  it("a Slack error answer resolves after exactly one attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    await expect(emitTradeRequestEvent(EXCLUSION)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain("channel_not_found");
  });

  it("TRADE_REQUESTS_SLACK=0 stops Slack but not the bells", async () => {
    vi.stubEnv("TRADE_REQUESTS_SLACK", "0");
    await emitTradeRequestEvent(SUBMITTED);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing with the epic master unset, even when AOA-served", async () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "");
    for (const event of ALL_EVENTS) await emitTradeRequestEvent(event);
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(servingMock).not.toHaveBeenCalled();
  });

  it("a failing Slack step is logged and the bells step still runs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...RESUBMITTED, clientName: undefined } as unknown as TradeRequestEvent;
    await expect(emitTradeRequestEvent(broken)).resolves.toBeUndefined();
    expect(JSON.stringify(error.mock.calls)).toContain("trade_request_side_effect_failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });
});
