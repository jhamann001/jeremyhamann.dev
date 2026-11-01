import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SLACK_MAX_LINES,
  SlackPiiError,
  assertPiiLight,
  isUsableWebhook,
  postSlack,
  slackPayloadText,
  ticketDeepLink,
  ticketLinkMarkup,
} from "@/jobs/slack";

const WEBHOOK = "https://hooks.slack.example/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("isUsableWebhook", () => {
  it("accepts an absolute https URL only", () => {
    expect(isUsableWebhook(WEBHOOK)).toBe(true);
    expect(isUsableWebhook(`  ${WEBHOOK}  `)).toBe(true);
    expect(isUsableWebhook("http://hooks.slack.example/services/x")).toBe(false);
    expect(isUsableWebhook("hooks.slack.example/services/x")).toBe(false);
    expect(isUsableWebhook("")).toBe(false);
    expect(isUsableWebhook("   ")).toBe(false);
    expect(isUsableWebhook(undefined)).toBe(false);
  });
});

describe("assertPiiLight", () => {
  it("passes a line built from ticket number, queue, priority and a deep link", () => {
    expect(() =>
      assertPiiLight(":red_circle: BREACHED | <https://desk.example/tickets/wm/1482|HD-1482> | OPERATIONS | HIGH | first response | 3h 05m over"),
    ).not.toThrow();
  });

  it("refuses an email address", () => {
    expect(() => assertPiiLight("HD-12 requester jane@example.com")).toThrow(SlackPiiError);
  });

  it("refuses a value sanitizePII recognises", () => {
    expect(() => assertPiiLight("HD-12 card 4111 1111 1111 1111")).toThrow(SlackPiiError);
    expect(() => assertPiiLight("HD-12 ssn 123-45-6789")).toThrow(SlackPiiError);
  });
});

describe("slackPayloadText", () => {
  it("joins lines with newlines", () => {
    expect(slackPayloadText([{ text: "one" }, { text: "two" }])).toBe("one\ntwo");
  });

  it("caps at SLACK_MAX_LINES and says how many were omitted", () => {
    const lines = Array.from({ length: SLACK_MAX_LINES + 7 }, (_, i) => ({ text: `line ${i}` }));
    const text = slackPayloadText(lines);
    expect(text.split("\n")).toHaveLength(SLACK_MAX_LINES + 1);
    expect(text).toContain("…and 7 more");
  });

  it("propagates a PII failure rather than redacting and sending", () => {
    expect(() => slackPayloadText([{ text: "ok" }, { text: "client@example.com" }])).toThrow(SlackPiiError);
  });
});

describe("postSlack", () => {
  it("is disabled — and posts nothing — when the webhook is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(postSlack(undefined, [{ text: "x" }])).resolves.toBe("disabled");
    await expect(postSlack("", [{ text: "x" }])).resolves.toBe("disabled");
    await expect(postSlack("http://insecure.example/hook", [{ text: "x" }])).resolves.toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is disabled when there is nothing to say", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(postSlack(WEBHOOK, [])).resolves.toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts a JSON body with the joined text", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(postSlack(WEBHOOK, [{ text: "a" }, { text: "b" }])).resolves.toBe("posted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "a\nb" });
  });

  it("reports failed on a non-2xx answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(postSlack(WEBHOOK, [{ text: "a" }])).resolves.toBe("failed");
  });

  it("reports failed — and never throws — when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(postSlack(WEBHOOK, [{ text: "a" }])).resolves.toBe("failed");
  });
});

describe("deep links", () => {
  it("builds an absolute link from the base URL", () => {
    expect(ticketDeepLink(1482, "https://desk.example")).toBe("https://desk.example/tickets/wm/1482");
    expect(ticketDeepLink(1482, "https://desk.example/")).toBe("https://desk.example/tickets/wm/1482");
  });

  it("falls back to the path when there is no usable base", () => {
    expect(ticketDeepLink(7, undefined)).toBe("/tickets/wm/7");
    expect(ticketDeepLink(7, "   ")).toBe("/tickets/wm/7");
    expect(ticketDeepLink(7, "not a url")).toBe("/tickets/wm/7");
  });

  it("renders Slack link markup only when the link is absolute", () => {
    expect(ticketLinkMarkup(12, "https://desk.example")).toBe("<https://desk.example/tickets/wm/12|HD-12>");
    expect(ticketLinkMarkup(12, undefined)).toBe("HD-12 /tickets/wm/12");
  });
});

describe("appBaseUrl", () => {
  // APP_BASE_URL is read through `@/lib/env`, which parses ONCE at import and validates it as an
  // absolute https origin, so exercising it means reloading the module graph. AUTH_URL is Auth.js's
  // own variable, read live from the process: it is legitimately http://localhost:3000 locally.
  it("prefers the validated APP_BASE_URL, falls back to AUTH_URL, and treats blank as unset", async () => {
    vi.stubEnv("APP_BASE_URL", "https://custom.example");
    vi.stubEnv("AUTH_URL", "https://auth.example");
    vi.resetModules();
    const withBase = await import("@/jobs/slack");
    expect(withBase.appBaseUrl()).toBe("https://custom.example");

    vi.stubEnv("APP_BASE_URL", "");
    vi.resetModules();
    const withoutBase = await import("@/jobs/slack");
    expect(withoutBase.appBaseUrl()).toBe("https://auth.example");

    vi.stubEnv("AUTH_URL", "");
    expect(withoutBase.appBaseUrl()).toBeUndefined();
  });

  it("refuses to start at all when APP_BASE_URL is set but is not an https origin", async () => {
    vi.stubEnv("APP_BASE_URL", "http://desk.internal");
    vi.resetModules();
    await expect(import("@/lib/env")).rejects.toThrow(/APP_BASE_URL/);
  });
});
