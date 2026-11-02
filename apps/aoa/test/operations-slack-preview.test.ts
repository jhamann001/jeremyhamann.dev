import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, findUnique } = vi.hoisted(() => ({ scopeSpy: vi.fn(), findUnique: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));

import { operationsSlackPreview, type OperationsSlackPreview as Preview } from "@/lib/data/operations-slack-preview";
import { OperationsSlackPreview } from "@/components/operations/OperationsSlackPreview";
import { buildOperationsSlackMessage, OPERATIONS_SLACK_CHANNEL, OPERATIONS_SLACK_ORIGIN } from "@/lib/slack/operations-fee-notifications";

const ID = "slack_preview_synthetic_0001";
const IDENTITY = { role: "OPERATIONS", email: "synthetic@example.test" };
const CREATED = new Date("2026-09-17T12:00:00Z");
const record = () => ({ id: ID, kind: "FEE_CREDIT", slack_notification: null });
const notification = (status = "PENDING") => ({ status, attempts: 0, event_id: 42n, created_at: CREATED, slack_ts: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_ENV", "dev");
  vi.stubEnv("OPERATIONS_TOOLS", "1");
  vi.stubEnv("OPERATIONS_FEE_REQUESTS", "1");
  vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", undefined);
  vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Preview cannot make network calls"); }));
  findUnique.mockResolvedValue(record());
  // No mutation or worker methods are available in this read-only transaction.
  scopeSpy.mockImplementation(async (_identity, fn) => fn({ operationsFeeRequest: { findUnique } }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("dev-only exact-request Slack preview read", () => {
  it.each([undefined, "prod", "preview", "DEV"])("does not read outside exact dev: %s", async (env) => {
    vi.stubEnv("APP_ENV", env);
    expect(await operationsSlackPreview(IDENTITY, ID)).toBeNull();
    expect(scopeSpy).not.toHaveBeenCalled();
  });
  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "unknown", null])("denies %s before reading", async (role) => {
    expect(await operationsSlackPreview({ ...IDENTITY, role }, ID)).toBeNull();
    expect(scopeSpy).not.toHaveBeenCalled();
  });
  it.each(["OPERATIONS_TOOLS", "OPERATIONS_FEE_REQUESTS"])("honors %s before reading", async (flag) => {
    vi.stubEnv(flag, "0");
    expect(await operationsSlackPreview(IDENTITY, ID)).toBeNull();
    expect(scopeSpy).not.toHaveBeenCalled();
  });
  it.each([null, "", " "])("requires an authenticated email: %j", async (email) => {
    expect(await operationsSlackPreview({ ...IDENTITY, email }, ID)).toBeNull();
    expect(scopeSpy).not.toHaveBeenCalled();
  });
  it.each(["", "short", "a".repeat(65), `${ID}\n`, `${ID}/other`])("rejects unsafe ID %j before reading", async (id) => {
    expect(await operationsSlackPreview(IDENTITY, id)).toBeNull();
    expect(scopeSpy).not.toHaveBeenCalled();
  });
  it.each(["OPERATIONS", "OPS", "ADMIN"])("uses %s identity and selects only exact safe metadata", async (role) => {
    const identity = { ...IDENTITY, role };
    const preview = await operationsSlackPreview(identity, ID);
    expect(scopeSpy).toHaveBeenCalledExactlyOnceWith(identity, expect.any(Function));
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: ID }, select: {
      id: true, kind: true, slack_notification: { select: {
        status: true, attempts: true, event_id: true, created_at: true, slack_ts: true,
      } },
    } });
    expect(preview).toEqual({ requestId: ID, captureEnabled: false, deliveryFlagEnabled: false,
      channel: OPERATIONS_SLACK_CHANNEL, message: buildOperationsSlackMessage("FEE_CREDIT", ID), notification: null });
  });
  it("does not distinguish a missing request from an RLS-hidden request", async () => {
    findUnique.mockResolvedValue(null);
    expect(await operationsSlackPreview(IDENTITY, ID)).toBeNull();
  });
  it("reports a persisted row independently of current flags without exposing the receipt or credentials", async () => {
    findUnique.mockResolvedValue({ ...record(), slack_notification: { ...notification("SENT"), attempts: 1, slack_ts: "1726574400.000001" } });
    vi.stubEnv("OPERATIONS_SLACK_BOT_TOKEN", "synthetic-secret-never-exposed");
    const preview = await operationsSlackPreview(IDENTITY, ID);
    expect(preview?.notification).toEqual({ status: "SENT", attempts: 1, eventId: "42", capturedAt: CREATED.toISOString(), receiptPresent: true });
    expect(preview?.captureEnabled).toBe(false);
    expect(JSON.stringify(preview)).not.toContain("1726574400.000001");
    expect(JSON.stringify(preview)).not.toContain("synthetic-secret");
  });
  it("reads both literal flags without enabling delivery in dev", async () => {
    vi.stubEnv("OPERATIONS_SLACK_CAPTURE_ENABLED", "true");
    vi.stubEnv("OPERATIONS_SLACK_DELIVERY_ENABLED", "true");
    const preview = await operationsSlackPreview(IDENTITY, ID);
    expect(preview).toMatchObject({ captureEnabled: true, deliveryFlagEnabled: true, notification: null });
    const html = renderToStaticMarkup(createElement(OperationsSlackPreview, { preview: preview! }));
    expect(html).toContain("Blocked in development");
    expect(html).toContain("No notification record exists");
  });
  it.each(["FEE_CREDIT", "SERVICE_GUARANTEE", "BILLING_EXCEPTION", "LARGE_HOUSEHOLD_EXCEPTION"] as const)("uses the unchanged pure %s template", async (kind) => {
    findUnique.mockResolvedValue({ ...record(), kind });
    expect((await operationsSlackPreview(IDENTITY, ID))?.message).toBe(buildOperationsSlackMessage(kind, ID));
  });
});

describe("read-only Slack preview rendering", () => {
  async function html(preview?: Preview) {
    return renderToStaticMarkup(createElement(OperationsSlackPreview, { preview: preview ?? (await operationsSlackPreview(IDENTITY, ID))! }));
  }
  it("renders literal production text inertly with only same-origin request navigation", async () => {
    const rendered = await html();
    expect(rendered).toContain("Preview only — no message sent by this view.");
    expect(rendered).toContain("No notification record exists for this request.");
    expect(rendered).toContain("future capture cutover requires separate approval");
    expect(rendered).toContain("NOT SENT by this preview");
    expect(rendered).toContain("may not exist in production");
    expect(rendered).toContain(`<pre`);
    expect(rendered).toContain(`${OPERATIONS_SLACK_ORIGIN}/operations/fee-requests?request=${ID}`);
    expect(rendered).not.toContain(`href="${OPERATIONS_SLACK_ORIGIN}`);
    expect(rendered).toContain(`href="/operations/fee-requests?request=${ID}#request-${ID}"`);
    expect(rendered).not.toMatch(/<form|<button/);
    expect(rendered).toMatch(/<details[^>]*><summary/);
    expect(rendered).not.toMatch(/<details[^>]*\sopen/);
  });
  it.each(["PENDING", "SENDING", "RETRY", "SENT", "FAILED", "UNCERTAIN"])("preserves actual %s status; the preview is not a delivery claim", async (status) => {
    findUnique.mockResolvedValue({ ...record(), slack_notification: { ...notification(status), slack_ts: status === "SENT" ? "1726574400.000001" : null } });
    const rendered = await html();
    expect(rendered).toContain(`<dd>${status}</dd>`);
    expect(rendered).toContain(`<dd>${status === "SENT" ? "Present" : "None"}</dd>`);
    expect(rendered).not.toContain("No notification record exists");
  });
  it("renders nothing in production even if handed a preview", async () => {
    const preview = (await operationsSlackPreview(IDENTITY, ID))!;
    vi.stubEnv("APP_ENV", "prod");
    expect(await html(preview)).toBe("");
  });
  it("renders a static unavailable state without implying there is no saved record", () => {
    const rendered = renderToStaticMarkup(createElement(OperationsSlackPreview, { preview: null }));
    expect(rendered).toContain("Slack preview is temporarily unavailable");
    expect(rendered).not.toContain("No notification record exists");
    expect(rendered).not.toContain("<pre");
  });
});
