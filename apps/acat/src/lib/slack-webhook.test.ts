import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSlackWebhookUrl,
  postToSlack,
  SlackWebhookError,
} from "./slack-webhook";

const SAVED = process.env.SLACK_WEBHOOK_URL;

beforeEach(() => {
  delete process.env.SLACK_WEBHOOK_URL;
});

afterEach(() => {
  if (SAVED) process.env.SLACK_WEBHOOK_URL = SAVED;
  else delete process.env.SLACK_WEBHOOK_URL;
});

describe("getSlackWebhookUrl", () => {
  it("returns null when unset", () => {
    expect(getSlackWebhookUrl()).toBeNull();
  });

  it("trims whitespace from the value", () => {
    process.env.SLACK_WEBHOOK_URL = "  https://hooks.slack.com/services/abc/def  ";
    expect(getSlackWebhookUrl()).toBe("https://hooks.slack.com/services/abc/def");
  });

  it("still returns a non-Slack URL but logs a warning (so onboarding mistakes show up)", () => {
    process.env.SLACK_WEBHOOK_URL = "https://example.com/webhook";
    expect(getSlackWebhookUrl()).toBe("https://example.com/webhook");
  });
});

describe("postToSlack", () => {
  it("throws SlackWebhookError when no URL is configured and none is provided", async () => {
    await expect(postToSlack({ text: "hi" })).rejects.toBeInstanceOf(
      SlackWebhookError
    );
  });

  it("POSTs JSON to the configured webhook URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await postToSlack(
      { text: "hello" },
      {
        webhookUrl: "https://hooks.slack.com/services/T1/B1/secret",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/T1/B1/secret");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ text: "hello" });
  });

  it("throws SlackWebhookError on non-2xx responses, including the status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "channel_not_found",
    });
    await expect(
      postToSlack(
        { text: "hi" },
        {
          webhookUrl: "https://hooks.slack.com/services/T1/B1/secret",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }
      )
    ).rejects.toMatchObject({
      name: "SlackWebhookError",
      status: 404,
    });
  });
});
