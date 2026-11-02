import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  DOCUMENT_CLIENT_WAIT_MS,
  SCAN_CLIENT_WAIT_MS,
  requestAllClientsPdf,
  requestHouseholdPdf,
  requestSaveToDrive,
  requestScan,
} from "@/components/asset-mapping/workspace/documents/documents-client";
import { performDriveSave, performPdf, performScan, type DocumentsDeps } from "@/components/asset-mapping/workspace/documents/run-documents";

const HID = "11111111-1111-4111-8111-111111111111";
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let timeout: MockInstance<typeof AbortSignal.timeout>;
beforeEach(() => {
  timeout = vi.spyOn(AbortSignal, "timeout");
});
afterEach(() => timeout.mockRestore());

describe("asset-mapping documents browser client", () => {
  it("PDFs GET the route handlers with the 305-second wait and no redirect following", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("%PDF-x", { status: 200, headers: { "Content-Disposition": 'attachment; filename="Synthetic_report.pdf"' } }));
    const one = await requestHouseholdPdf(HID, fetcher);
    const all = await requestAllClientsPdf(fetcher);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([`/api/asset-mapping/households/${HID}/pdf`, "/api/asset-mapping/export-pdf"]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error" });
    expect(timeout.mock.calls).toEqual([[305_000], [305_000]]);
    expect(DOCUMENT_CLIENT_WAIT_MS).toBe(305_000);
    expect(one.ok && one.filename).toBe("Synthetic_report.pdf");
    expect(all.ok && (await all.blob.text())).toBe("%PDF-x");
  });

  it("Save to Drive POSTs with the 305-second wait and maps the body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonRes(200, { filename: "f.pdf", webViewLink: "https://drive.example.test/f", reviewedAt: "2026-10-04T13:00:00", reviewer: "ops.person@example.invalid" }));
    expect(await requestSaveToDrive(HID, fetcher)).toEqual({ ok: true, filename: "f.pdf", webViewLink: "https://drive.example.test/f", reviewedAt: "2026-10-04T13:00:00", reviewer: "ops.person@example.invalid" });
    expect(fetcher.mock.calls[0][0]).toBe(`/api/asset-mapping/households/${HID}/save-to-drive`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(timeout.mock.calls).toEqual([[305_000]]);
  });

  it("manual scan POSTs with the 1190-second wait and maps each status", async () => {
    expect(await requestScan(vi.fn(async () => jsonRes(200, { clientsProcessed: 4 })))).toEqual({ kind: "finished", clientsProcessed: 4 });
    expect(await requestScan(vi.fn(async () => jsonRes(409, { error: "busy" })))).toEqual({ kind: "busy" });
    expect(await requestScan(vi.fn(async () => jsonRes(403, { error: "forbidden" })))).toEqual({ kind: "forbidden" });
    expect(await requestScan(vi.fn(async () => jsonRes(502, { error: "failed", status: 500, detail: "d" })))).toEqual({ kind: "failed", status: 500, detail: "d" });
    expect(timeout.mock.calls.every((c) => c[0] === 1_190_000)).toBe(true);
    expect(SCAN_CLIENT_WAIT_MS).toBe(1_190_000);
  });

  it("an abort, network error, or redirect to sign-in maps to failed with no status", async () => {
    const throws = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await requestScan(throws)).toEqual({ kind: "failed", status: null, detail: null });
    expect(await requestHouseholdPdf(HID, throws)).toEqual({ ok: false, forbidden: false, status: null });
    expect(await requestSaveToDrive(HID, throws)).toEqual({ ok: false, forbidden: false, status: null });
  });

  it("401, 403, and 404 map to not allowed; 502 carries the pipeline status", async () => {
    for (const status of [401, 403, 404]) {
      expect(await requestHouseholdPdf(HID, vi.fn(async () => jsonRes(status, {})))).toEqual({ ok: false, forbidden: true, status: null });
    }
    expect(await requestSaveToDrive(HID, vi.fn(async () => jsonRes(502, { error: "failed", status: 500 })))).toEqual({ ok: false, forbidden: false, status: 500 });
  });
});

function deps(client: Partial<DocumentsDeps["client"]>) {
  const d = {
    client: { householdPdf: vi.fn(), allClientsPdf: vi.fn(), saveToDrive: vi.fn(), scan: vi.fn(), ...client },
    dispatch: vi.fn(), schedule: vi.fn((_fn: () => void, _ms: number) => vi.fn()), download: vi.fn(),
    scanClear: { cancel: null as (() => void) | null },
  };
  return d as typeof d & DocumentsDeps;
}

describe("asset-mapping documents runners", () => {
  it("a finished scan re-reads the list and clears the message after 6 seconds", async () => {
    const d = deps({ scan: vi.fn(async () => ({ kind: "finished" as const, clientsProcessed: 2 })) });
    const onFinished = vi.fn();
    await performScan(onFinished, d);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(d.dispatch.mock.calls.map((c) => c[0].type)).toEqual(["start", "scanDone"]);
    expect(d.schedule.mock.calls[0][1]).toBe(6000);
  });

  it("a newer scan cancels the older scan-message clear, so the old timer cannot clear the new message", async () => {
    const d = deps({ scan: vi.fn(async () => ({ kind: "busy" as const })) });
    await performScan(vi.fn(), d);
    const firstCancel = d.schedule.mock.results[0].value;
    await performScan(vi.fn(), d);
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(d.schedule).toHaveBeenCalledTimes(2);
    expect(d.scanClear.cancel).toBe(d.schedule.mock.results[1].value);
    expect(d.schedule.mock.results[1].value).not.toHaveBeenCalled();
  });

  it("a busy or failed scan does not re-read the list", async () => {
    for (const result of [{ kind: "busy" as const }, { kind: "failed" as const, status: null, detail: null }]) {
      const onFinished = vi.fn();
      await performScan(onFinished, deps({ scan: vi.fn(async () => result) }));
      expect(onFinished).not.toHaveBeenCalled();
    }
  });

  it("a PDF downloads the blob under the route's filename", async () => {
    const blob = new Blob(["%PDF-x"]);
    const d = deps({ householdPdf: vi.fn(async () => ({ ok: true as const, filename: "f.pdf", blob })) });
    await performPdf("pdf", HID, d);
    expect(d.download).toHaveBeenCalledWith(blob, "f.pdf");
    expect(d.dispatch.mock.calls.at(-1)?.[0]).toEqual({ type: "pdfDone", kind: "pdf" });
  });

  it("a Drive save failure raises the alert and schedules nothing", async () => {
    const d = deps({ saveToDrive: vi.fn(async () => ({ ok: false as const, forbidden: false, status: 502 })) });
    await performDriveSave("saveToDrive", HID, d);
    expect(d.dispatch.mock.calls.at(-1)?.[0]).toEqual({ type: "failed", kind: "saveToDrive", householdId: HID, text: "Save to Drive failed (502)" });
    expect(d.schedule).not.toHaveBeenCalled();
  });

  it("a Drive save success records it and clears the notice after 8 seconds", async () => {
    const d = deps({ saveToDrive: vi.fn(async () => ({ ok: true as const, filename: "f.pdf", webViewLink: "l", reviewedAt: "2026-10-04T13:00:00", reviewer: "r" })) });
    await performDriveSave("markCompleted", HID, d);
    expect(d.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ type: "driveSaved", kind: "markCompleted", householdId: HID, reviewedAt: "2026-10-04T13:00:00" });
    expect(d.schedule.mock.calls[0][1]).toBe(8000);
    d.schedule.mock.calls[0][0]();
    expect(d.dispatch.mock.calls.at(-1)?.[0]).toEqual({ type: "clearNotice", householdId: HID });
  });
});
