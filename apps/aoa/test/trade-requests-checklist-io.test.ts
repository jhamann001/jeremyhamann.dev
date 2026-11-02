import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));

import { loadRequestChecklist, saveRequestChecklistItem } from "@/lib/trade-requests/checklist";
import { readRequestChecklist, writeRequestChecklistItem } from "@/app/(authenticated)/trade-requests/checklist-actions";

// ticket: checklist read and write through the delegated client (AC-15,
// AC-84, AC-85, AC-151) and the server actions' flag and input checks. Synthetic data.

const STORED = {
  exclusions: { checked: true, value: "", by: "Riley Ops", at: "2026-10-15T15:00:00.000Z" },
  templates: { checked: false, value: "Synthetic Template", by: "Riley Ops", at: "2026-10-15T15:01:00.000Z" },
};

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
});

describe("loadRequestChecklist (ticket)", () => {
  it("reads GET /requests/:id/checklist with the checklist-read policy", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { checklist: STORED } });
    await expect(loadRequestChecklist("REQ SYN/1")).resolves.toEqual({ ok: true, checklist: STORED });
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({
      operation: "checklistRead", method: "GET", path: "/requests/REQ%20SYN%2F1/checklist",
    }));
  });

  it("drops unknown items and malformed fields", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { checklist: { bogus: { checked: true }, residual_cash: { checked: "yes", value: 3 } } } });
    await expect(loadRequestChecklist("REQ-SYN1")).resolves.toEqual({
      ok: true, checklist: { residual_cash: { checked: false, value: "", by: null, at: null } },
    });
  });

  it("fails for a service failure, a malformed body or an id that cannot be a request (AC-84)", async () => {
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 503, message: "Service Unavailable" });
    await expect(loadRequestChecklist("REQ-SYN1")).resolves.toEqual({ ok: false, message: "Service Unavailable" });
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: { checklist: [] } });
    await expect(loadRequestChecklist("REQ-SYN1")).resolves.toMatchObject({ ok: false });
    await expect(loadRequestChecklist("..")).resolves.toMatchObject({ ok: false });
    expect(m.call).toHaveBeenCalledTimes(2);
  });
});

describe("saveRequestChecklistItem (ticket)", () => {
  it("writes one item with PUT and the checklist-save policy", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { checklist: STORED } });
    await expect(saveRequestChecklistItem("REQ-SYN1", { key: "templates", checked: false, value: "Synthetic Template" }))
      .resolves.toEqual({ ok: true, checklist: STORED });
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({
      operation: "checklistSave", method: "PUT", path: "/requests/REQ-SYN1/checklist",
      body: { key: "templates", checked: false, value: "Synthetic Template" },
    }));
  });

  it("returns the service's refusal of a decided request (AC-48)", async () => {
    m.call.mockResolvedValue({ ok: false, outcome: "failed", status: 409, message: "Checklist is locked — the request has already been decided." });
    await expect(saveRequestChecklistItem("REQ-SYN1", { key: "exclusions", checked: true, value: "" }))
      .resolves.toEqual({ ok: false, message: "Checklist is locked — the request has already been decided." });
  });
});

describe("checklist server actions (ticket)", () => {
  it("call nothing while the flag is off", async () => {
    m.enabled.mockReturnValue(false);
    await expect(readRequestChecklist("REQ-SYN1")).resolves.toMatchObject({ ok: false });
    await expect(writeRequestChecklistItem("REQ-SYN1", { key: "exclusions", checked: true, value: "" })).resolves.toMatchObject({ ok: false });
    expect(m.call).not.toHaveBeenCalled();
  });

  it("refuse malformed ids and changes before calling the service", async () => {
    for (const [id, change] of [
      [42, { key: "exclusions", checked: true, value: "" }],
      ["X".repeat(101), { key: "exclusions", checked: true, value: "" }],
      ["REQ-SYN1", null],
      ["REQ-SYN1", { key: "bogus", checked: true, value: "" }],
      ["REQ-SYN1", { key: "exclusions", checked: "true", value: "" }],
      ["REQ-SYN1", { key: "templates", checked: true, value: "x".repeat(2001) }],
    ] as const) {
      await expect(writeRequestChecklistItem(id, change)).resolves.toMatchObject({ ok: false });
    }
    await expect(readRequestChecklist(undefined)).resolves.toMatchObject({ ok: false });
    expect(m.call).not.toHaveBeenCalled();
  });

  it("pass a valid read and write to the delegated client", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { checklist: {} } });
    await expect(readRequestChecklist("REQ-SYN1")).resolves.toEqual({ ok: true, checklist: {} });
    await expect(writeRequestChecklistItem("REQ-SYN1", { key: "advisor_tickers", checked: true, value: "SYNQ" }))
      .resolves.toEqual({ ok: true, checklist: {} });
    expect(m.call).toHaveBeenLastCalledWith(expect.objectContaining({ body: { key: "advisor_tickers", checked: true, value: "SYNQ" } }));
  });
});
