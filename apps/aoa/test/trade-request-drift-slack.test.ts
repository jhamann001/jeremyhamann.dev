import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ticket: the drift channel sender and the readiness check the alert uses before claiming its date.
const m = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/slack/trade-requests", () => ({ sendTradeRequestSlack: m.send }));

import { sendDriftChannelMessage } from "@/lib/trade-requests/drift/slack";
import { driftChannelReady } from "@/lib/trade-requests/drift/targets";

const KEYS = ["EPIC_TRADE_REQUESTS_BACKEND_MOVE", "TRADE_REQUESTS_SLACK", "TRADE_REQUEST_SLACK_BOT_TOKEN", "TRADE_REQUEST_SLACK_CHANNEL_ID", "TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID"];
beforeEach(() => {
  vi.clearAllMocks();
  process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE = "1";
  process.env.TRADE_REQUEST_SLACK_BOT_TOKEN = "xoxb-fixture";
  process.env.TRADE_REQUEST_SLACK_CHANNEL_ID = "CTRADES123";
  process.env.TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID = "CDRIFT123";
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("drift channel sender", () => {
  it("posts once to the drift channel through ticket's channel destination", async () => {
    m.send.mockResolvedValue({ status: "sent" });
    await expect(sendDriftChannelMessage("text")).resolves.toBeUndefined();
    expect(m.send).toHaveBeenCalledWith({ channel: "CDRIFT123" }, "text");
  });
  it("throws on a skipped send so the caller releases its claim", async () => {
    m.send.mockResolvedValue({ status: "skipped" });
    await expect(sendDriftChannelMessage("text")).rejects.toThrow(/not sent: sender_skipped/);
  });
  it("throws on a failed send with the code only", async () => {
    m.send.mockResolvedValue({ status: "failed", code: "timeout" });
    await expect(sendDriftChannelMessage("text")).rejects.toThrow("drift Slack post failed: timeout");
  });
  it("throws without calling Slack when the drift channel is missing or not a channel id", async () => {
    for (const value of [undefined, "", "U123USER"]) {
      if (value === undefined) delete process.env.TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID;
      else process.env.TRADE_REQUEST_DRIFT_SLACK_CHANNEL_ID = value;
      await expect(sendDriftChannelMessage("text")).rejects.toThrow(/channel_not_configured/);
    }
    expect(m.send).not.toHaveBeenCalled();
  });
  it("is ready only with the epic master, the breaker on, ticket's bot token and channel, and a drift channel id", () => {
    expect(driftChannelReady()).toBe(true);
    process.env.TRADE_REQUESTS_SLACK = "0";
    expect(driftChannelReady()).toBe(false);
    delete process.env.TRADE_REQUESTS_SLACK;
    delete process.env.TRADE_REQUEST_SLACK_BOT_TOKEN;
    expect(driftChannelReady()).toBe(false);
    process.env.TRADE_REQUEST_SLACK_BOT_TOKEN = "xoxb-fixture";
    delete process.env.TRADE_REQUEST_SLACK_CHANNEL_ID;
    expect(driftChannelReady()).toBe(false);
    process.env.TRADE_REQUEST_SLACK_CHANNEL_ID = "CTRADES123";
    delete process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE;
    expect(driftChannelReady()).toBe(false);
  });
});
