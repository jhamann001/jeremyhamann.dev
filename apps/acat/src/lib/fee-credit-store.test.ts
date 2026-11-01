import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import { createFeeCreditRow, deleteFeeCreditRow, listFeeCreditRows } from "./fee-credit-store";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configure() {
  vi.stubEnv("FEE_STORE_API_KEY", "test-key");
  vi.stubEnv("FEE_STORE_DB_URL", "https://fee-store.test/db");
  vi.stubEnv("FEE_STORE_FEES_TABLE_ID", "fees");
}

describe("fee-credit-store", () => {
  it("lists rows from either Fee Store response shape", async () => {
    markCase("fee-credit-store", "lists rows from either Fee Store response shape");
    configure();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: "1" }] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ id: "2" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listFeeCreditRows({ clientName: "Ada" })).resolves.toMatchObject({ ok: true, body: [{ id: "1" }] });
    await expect(listFeeCreditRows({ accountNumber: "BLU" })).resolves.toMatchObject({ ok: true, body: { data: [{ id: "2" }] } });
  });

  it("creates a Pending row with the fee Apex ticket", async () => {
    markCase("fee-credit-store", "creates a Pending row with the fee Apex ticket");
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "9" }) });
    vi.stubGlobal("fetch", fetchMock);
    const created = await createFeeCreditRow({
      clientName: "Synthetic Fee Client",
      feeAmount: 10,
      accountNumber: "APX-FEE-SECRET-326",
      apexRequest: "FEE-326",
    });
    expect(created.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.status).toBe("Pending");
    expect(body.apex_request).toBe("FEE-326");
  });

  it("deletes a row by id", async () => {
    markCase("fee-credit-store", "deletes a row by id");
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await deleteFeeCreditRow("9");
    expect(fetchMock.mock.calls[0][0]).toBe("https://fee-store.test/db/fees/rows/9");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("reports not configured without calling fetch", async () => {
    markCase("fee-credit-store", "reports not configured without calling fetch");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listFeeCreditRows({})).resolves.toEqual({ ok: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns invalid when the create body fails the fee schema and does not call fetch", async () => {
    markCase("fee-credit-store", "returns invalid when the create body fails the fee schema and does not call fetch");
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await createFeeCreditRow({ clientName: "", feeAmount: 10, accountNumber: "BLU" });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not delete when the id is empty", async () => {
    markCase("fee-credit-store", "does not delete when the id is empty");
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteFeeCreditRow("")).resolves.toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unreadable when a successful create body does not parse", async () => {
    markCase("fee-credit-store", "returns unreadable when a successful create body does not parse");
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error("bad json"); },
    }));
    const result = await createFeeCreditRow({ clientName: "Ada", feeAmount: 10, accountNumber: "BLU" });
    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });
});
