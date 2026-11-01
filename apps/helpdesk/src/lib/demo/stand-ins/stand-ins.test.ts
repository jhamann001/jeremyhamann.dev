import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoMode, isStandInUrl } from "@/lib/demo/mode";
import type { OutboxEntry } from "@/lib/demo/outbox";
import { configuredSlackUrls, startSlackStandIn } from "./slack";
import { drainOnce, standInProviderId, type SenderDeps } from "./sender";

describe("the demo switch", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("STAND_INS_PORT", "8090");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only plain http to 127.0.0.1 on the stand-ins' port, and only in demo mode", () => {
    expect(isStandInUrl("http://127.0.0.1:8090/slack/sla-alerts/abc")).toBe(true);
    expect(isStandInUrl("http://127.0.0.1:8091/slack/sla-alerts/abc")).toBe(false);
    expect(isStandInUrl("http://localhost:8090/slack/sla-alerts/abc")).toBe(false);
    expect(isStandInUrl("http://10.0.0.5:8090/slack")).toBe(false);
    expect(isStandInUrl("https://127.0.0.1:8090/slack")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "off");
    expect(isStandInUrl("http://127.0.0.1:8090/slack/sla-alerts/abc")).toBe(false);
  });

  it("is never on where APP_ENV=production", () => {
    expect(demoMode()).toBe(true);
    vi.stubEnv("APP_ENV", "production");
    expect(demoMode()).toBe(false);
    expect(isStandInUrl("http://127.0.0.1:8090/slack/sla-alerts/abc")).toBe(false);
  });
});

describe("the Slack stand-in", () => {
  let server: Server;
  let base: string;
  const recorded: OutboxEntry[] = [];
  const hook = "/slack/sla-alerts/0123456789abcdef";

  beforeEach(async () => {
    recorded.length = 0;
    server = await startSlackStandIn(
      { record: async (e) => void recorded.push(e), now: () => new Date("2026-10-28T14:00:00Z"), configuredUrls: () => [`http://127.0.0.1:8090${hook}`] },
      0,
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (path: string, body: string, method = "POST") =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body } : {}) });

  it("files a post to a configured webhook in the Outbox, under its channel", async () => {
    const res = await post(hook, JSON.stringify({ text: "*SLA sweep:* 2 new alerts\nHD-2479 breached" }));
    expect(res.status).toBe(200);
    expect(recorded).toEqual([
      expect.objectContaining({ transport: "slack", destination: "#sla-alerts", title: "*SLA sweep:* 2 new alerts" }),
    ]);
  });

  it("refuses any path the app was not configured with, as Slack refuses a wrong webhook", async () => {
    expect((await post("/slack/sla-alerts/wrong", JSON.stringify({ text: "x" }))).status).toBe(404);
    expect((await post("/elsewhere", JSON.stringify({ text: "x" }))).status).toBe(404);
    expect((await post(hook, "", "GET")).status).toBe(404);
    expect((await post(hook, "not json")).status).toBe(400);
    expect((await post(hook, JSON.stringify({ text: " " }))).status).toBe(400);
    expect(recorded).toHaveLength(0);
  });

  it("reads every configured address: the SLA hook and each queue's", () => {
    expect(
      configuredSlackUrls({
        SLA_ALERT_SLACK_WEBHOOK_URL: "http://127.0.0.1:8090/slack/sla-alerts/a",
        SLACK_QUEUE_WEBHOOKS: JSON.stringify({ OPERATIONS: "http://127.0.0.1:8090/slack/ops-desk/b" }),
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual(["http://127.0.0.1:8090/slack/sla-alerts/a", "http://127.0.0.1:8090/slack/ops-desk/b"]);
  });
});

describe("the stand-in mail sender", () => {
  const lease = {
    id: "dlv_1",
    ticketNumber: 2496,
    brand: "CEDAR_RIDGE_WEALTH",
    from: "service@example.com",
    fromName: "Cedar Ridge Wealth",
    replyTo: "service+tok@example.com",
    to: "neil.cole@example.com",
    subject: "[HD-2496] New mailing address",
    textBody: "Hello Neil",
    htmlBody: "<p>Hello Neil</p>",
    messageId: "<dlv_1@example.com>",
    inReplyTo: null,
    references: null,
    attempts: 1,
    leaseExpiresAt: "2026-10-28T14:05:00Z",
  };

  function deps(over: Partial<SenderDeps> = {}) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const recorded: OutboxEntry[] = [];
    const d: SenderDeps = {
      pending: async () => 1,
      alreadyFiled: async () => false,
      record: async (e) => void recorded.push(e),
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes("?status=QUEUED")) return Response.json({ deliveries: [lease], count: 1, leaseMs: 300000 });
        return Response.json({ id: "dlv_1", status: "SENT", attempts: 1 });
      }) as typeof fetch,
      baseUrl: "http://127.0.0.1:3000",
      token: "outbox-key",
      ...over,
    };
    return { d, calls, recorded };
  }

  it("does nothing, not even a lease, while nothing is queued", async () => {
    const { d, calls } = deps({ pending: async () => 0 });
    expect(await drainOnce(d)).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it("leases through the outbox route with the key, files the email, and reports it sent", async () => {
    const { d, calls, recorded } = deps();
    expect(await drainOnce(d)).toEqual({ sent: 1, failed: 0 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:3000/api/integrations/outbox?status=QUEUED&limit=25");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer outbox-key");
    expect(recorded).toEqual([
      expect.objectContaining({ transport: "email", destination: "neil.cole@example.com", deliveryId: "dlv_1" }),
    ]);
    expect(calls[1]!.url).toBe("http://127.0.0.1:3000/api/integrations/outbox/dlv_1");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ outcome: "SENT", providerMessageId: standInProviderId("dlv_1") });
  });

  it("files a delivery once when its lease ran out and it was taken again", async () => {
    const { d, recorded } = deps({ alreadyFiled: async () => true });
    expect(await drainOnce(d)).toEqual({ sent: 1, failed: 0 });
    expect(recorded).toHaveLength(0);
  });

  it("fails loudly when the lease is refused", async () => {
    const { d } = deps({ fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
    await expect(drainOnce(d)).rejects.toThrow("outbox lease answered 401");
  });
});
