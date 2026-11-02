import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import type { Prisma } from "@prisma/client";
import {
  DOCUMENT_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  fetchAssetMapAllClientsPdf,
  fetchAssetMapHouseholdPdf,
  readAssetMapDriveSaveAudit,
  runAssetMapScan,
  saveAssetMapHouseholdToDrive,
} from "@/lib/data/asset-map-documents";
import { SCAN_CLIENT_WAIT_MS } from "@/components/asset-mapping/workspace/documents/documents-client";

const BASE = "https://pipeline.example.test";
const HID = "11111111-1111-4111-8111-111111111111";
const pdfBytes = () => new TextEncoder().encode("%PDF-synthetic").buffer;
const opts = (i = 0) => requestMock.mock.calls[i][0] as { url: string; method: string; timeout: number; responseType: string };

let err: MockInstance<typeof console.error>;
beforeEach(() => {
  requestMock.mockReset();
  getIdTokenClientMock.mockClear();
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => err.mockRestore());

describe("asset-map documents pipeline client", () => {
  it("household PDF calls GET /api/households/{id}/pdf with the 300-second wait and returns the bytes and the filename", async () => {
    requestMock.mockResolvedValue({
      status: 200, data: pdfBytes(),
      headers: new Headers({ "content-disposition": 'attachment; filename="Synthetic_Client_report_2026-10-04.pdf"' }),
    });
    const res = await fetchAssetMapHouseholdPdf(BASE, HID);
    expect(opts()).toMatchObject({ url: `${BASE}/api/households/${HID}/pdf`, method: "GET", timeout: 300_000, responseType: "arraybuffer" });
    expect(res).toMatchObject({ ok: true, data: { filename: "Synthetic_Client_report_2026-10-04.pdf" } });
    expect(res.ok && new TextDecoder().decode(res.data.bytes)).toBe("%PDF-synthetic");
  });

  it("all-clients PDF calls GET /api/households/export/pdf with the 300-second wait", async () => {
    requestMock.mockResolvedValue({ status: 200, data: pdfBytes(), headers: { "content-disposition": 'attachment; filename="all_clients_report_2026-10-04.pdf"' } });
    const res = await fetchAssetMapAllClientsPdf(BASE);
    expect(opts()).toMatchObject({ url: `${BASE}/api/households/export/pdf`, method: "GET", timeout: 300_000 });
    expect(res).toMatchObject({ ok: true, data: { filename: "all_clients_report_2026-10-04.pdf" } });
  });

  it("Save to Drive calls POST save-to-drive with the 300-second wait and maps the response", async () => {
    requestMock.mockResolvedValue({
      status: 200, headers: {},
      data: { file_id: "f", web_view_link: "https://drive.example.test/f", filename: "Synthetic_report.pdf", reviewed_at: "2026-10-04T13:00:00.123456-04:00", reviewed_by: "sa@example.invalid" },
    });
    const res = await saveAssetMapHouseholdToDrive(BASE, HID);
    expect(opts()).toMatchObject({ url: `${BASE}/api/households/${HID}/save-to-drive`, method: "POST", timeout: 300_000, responseType: "json" });
    expect(res).toEqual({ ok: true, data: { filename: "Synthetic_report.pdf", webViewLink: "https://drive.example.test/f", reviewedAt: "2026-10-04T13:00:00.123456-04:00" } });
  });

  it("manual scan calls POST /api/scan with the 1180-second wait and returns the client count", async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { clients_processed: 3, results: [] } });
    expect(await runAssetMapScan(BASE)).toEqual({ ok: true, clientsProcessed: 3 });
    expect(opts()).toMatchObject({ url: `${BASE}/api/scan`, method: "POST", timeout: 1_180_000 });
  });

  it("manual scan maps 409 to busy", async () => {
    requestMock.mockResolvedValue({ status: 409, headers: {}, data: { detail: "A scan is already in progress" } });
    expect(await runAssetMapScan(BASE)).toEqual({ ok: false, reason: "busy" });
  });

  it("manual scan maps another status to failed with the pipeline detail text", async () => {
    requestMock.mockResolvedValue({ status: 500, headers: {}, data: { detail: "Scan failed. Check server logs for details." } });
    expect(await runAssetMapScan(BASE)).toEqual({ ok: false, reason: "failed", status: 500, detail: "Scan failed. Check server logs for details." });
    requestMock.mockResolvedValue({ status: 500, headers: {}, data: { detail: "x".repeat(201) } });
    expect(await runAssetMapScan(BASE)).toEqual({ ok: false, reason: "failed", status: 500, detail: null });
  });

  it("manual scan maps a transport failure or timeout to failed with no status", async () => {
    requestMock.mockRejectedValue(new Error("timeout of 1180000ms exceeded"));
    expect(await runAssetMapScan(BASE)).toEqual({ ok: false, reason: "failed", status: null, detail: null });
  });

  it("PDF and Drive map a non-2xx status to failed with that status", async () => {
    for (const status of [404, 500, 502]) {
      requestMock.mockResolvedValue({ status, headers: {}, data: {} });
      expect(await fetchAssetMapHouseholdPdf(BASE, HID)).toEqual({ ok: false, reason: "failed", status });
      expect(await fetchAssetMapAllClientsPdf(BASE)).toEqual({ ok: false, reason: "failed", status });
      expect(await saveAssetMapHouseholdToDrive(BASE, HID)).toEqual({ ok: false, reason: "failed", status });
    }
  });

  it("PDF and Drive map a transport failure or timeout to failed with no status", async () => {
    requestMock.mockRejectedValue(new Error("timeout of 300000ms exceeded"));
    expect(await fetchAssetMapHouseholdPdf(BASE, HID)).toEqual({ ok: false, reason: "failed", status: null });
    expect(await saveAssetMapHouseholdToDrive(BASE, HID)).toEqual({ ok: false, reason: "failed", status: null });
  });

  it("mints the token for the pipeline base URL as audience", async () => {
    requestMock.mockResolvedValue({ status: 500, headers: {}, data: {} });
    await fetchAssetMapHouseholdPdf(BASE, HID);
    await fetchAssetMapAllClientsPdf(BASE);
    await saveAssetMapHouseholdToDrive(BASE, HID);
    await runAssetMapScan(BASE);
    expect(getIdTokenClientMock.mock.calls).toEqual([[BASE], [BASE], [BASE], [BASE]]);
  });

  it("never logs the url, token, or body", async () => {
    requestMock.mockResolvedValueOnce({ status: 502, headers: {}, data: { detail: "Synthetic Client body" } });
    await saveAssetMapHouseholdToDrive(BASE, HID);
    requestMock.mockRejectedValueOnce(new Error(`${BASE} Synthetic`));
    await runAssetMapScan(BASE);
    requestMock.mockResolvedValueOnce({ status: 404, headers: {}, data: {} });
    await fetchAssetMapHouseholdPdf(BASE, HID);
    const lines = err.mock.calls.map((c) => c.join(" "));
    expect(lines).toEqual(["[asset-map] drive_status=502", "[asset-map] documents_transport_failed", "[asset-map] pdf_status=404"]);
  });

  it("reads the latest Drive-save audit row for one household", async () => {
    const query = vi.fn();
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    query.mockResolvedValueOnce([{ actorEmail: "ops.person@example.invalid", detail: '{"reviewedAt":"2026-10-04T13:00:00"}' }]);
    expect(await readAssetMapDriveSaveAudit(tx, HID)).toEqual({ reviewedAt: "2026-10-04T13:00:00", reviewer: "ops.person@example.invalid" });
    const sql = query.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join("?")).toContain('ORDER BY at DESC, id DESC LIMIT 1');
    expect(sql.values).toEqual(["asset_map_documents.drive_save", "asset_map_household", HID]);
    query.mockResolvedValueOnce([{ actorEmail: "ops.person@example.invalid", detail: "not json" }]);
    expect(await readAssetMapDriveSaveAudit(tx, HID)).toBeNull();
    query.mockResolvedValueOnce([{ actorEmail: null, detail: '{"reviewedAt":"2026-10-04T13:00:00"}' }]);
    expect(await readAssetMapDriveSaveAudit(tx, HID)).toBeNull();
    query.mockResolvedValueOnce([]);
    expect(await readAssetMapDriveSaveAudit(tx, HID)).toBeNull();
  });

  it("the waits order as the route, then the browser, then the 1200-second production service", () => {
    expect(DOCUMENT_TIMEOUT_MS).toBe(300_000);
    expect(SCAN_TIMEOUT_MS).toBe(1_180_000);
    expect(SCAN_CLIENT_WAIT_MS).toBe(1_190_000);
    // The production service's 1200 s request timeout is set in its Terraform, which this copy doesn't carry.
    expect(SCAN_TIMEOUT_MS).toBeLessThan(SCAN_CLIENT_WAIT_MS);
    expect(SCAN_CLIENT_WAIT_MS).toBeLessThan(1_200_000);
    expect(readFileSync("lib/data/asset-map.ts", "utf8")).toContain("const EDIT_TIMEOUT_MS = 15_000;");
  });
});
