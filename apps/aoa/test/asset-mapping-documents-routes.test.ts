import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  docs: vi.fn(),
  scope: vi.fn(),
  writeAudit: vi.fn(),
  base: vi.fn(),
  pdf: vi.fn(),
  allPdf: vi.fn(),
  drive: vi.fn(),
  scan: vi.fn(),
  readAudit: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({
  assetMappingReadEnabled: () => true,
  assetMappingEditsEnabled: () => false,
  assetMappingDocumentsEnabled: m.docs,
}));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  writeAudit: m.writeAudit,
}));
vi.mock("@/lib/data/asset-map", () => ({ assetMapBaseUrl: m.base }));
vi.mock("@/lib/data/asset-map-documents", () => ({
  fetchAssetMapHouseholdPdf: m.pdf,
  fetchAssetMapAllClientsPdf: m.allPdf,
  saveAssetMapHouseholdToDrive: m.drive,
  runAssetMapScan: m.scan,
  readAssetMapDriveSaveAudit: m.readAudit,
}));

import { GET as householdPdf } from "@/app/api/asset-mapping/households/[householdId]/pdf/route";
import { GET as allClientsPdf } from "@/app/api/asset-mapping/export-pdf/route";
import { POST as saveToDrive } from "@/app/api/asset-mapping/households/[householdId]/save-to-drive/route";
import { POST as scan } from "@/app/api/asset-mapping/scan/route";
import { loadAssetMapDriveSaveReviewer } from "@/app/(authenticated)/asset-mapping/actions";

const HID = "11111111-1111-4111-8111-111111111111";
const BASE = "https://pipeline.example.test";
const req = (method: "GET" | "POST", headers: Record<string, string> = {}) => new Request("http://localhost/x", { method, headers });
const ctx = (householdId = HID) => ({ params: Promise.resolve({ householdId }) });
const signIn = (role: string, email = "person@example.invalid") => m.auth.mockResolvedValue({ user: { role, email } });
const pdfOk = (filename: string) => ({ ok: true, data: { filename, bytes: new TextEncoder().encode("%PDF-x") } });

const routes = {
  householdPdf: () => householdPdf(req("GET"), ctx()),
  allClientsPdf: () => allClientsPdf(req("GET")),
  saveToDrive: () => saveToDrive(req("POST"), ctx()),
  scan: () => scan(req("POST")),
};
const NOT_OPERATE_ROLES = ["CLIENT_SERVICE", "ADVISOR", "VIEWER", "HEAD_OF_ADVISORY"];
// Roles that may download both PDFs read-only (ticket): the statement-pipeline `advisor` scope.
const READ_ONLY_ROLES = ["ADVISOR", "CLIENT_SERVICE"];
const NO_VIEW_ROLES = ["VIEWER", "HEAD_OF_ADVISORY"];

let err: MockInstance<typeof console.error>;
beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.docs.mockReturnValue(true);
  m.base.mockReturnValue(BASE);
  m.scope.mockImplementation(async (_identity: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }));
  m.writeAudit.mockResolvedValue(undefined);
  m.pdf.mockResolvedValue(pdfOk("Synthetic_report.pdf"));
  m.allPdf.mockResolvedValue(pdfOk("all_clients_report.pdf"));
  m.drive.mockResolvedValue({ ok: true, data: { filename: "Synthetic_report.pdf", webViewLink: "https://drive.example.test/f", reviewedAt: "2026-10-04T13:00:00" } });
  m.scan.mockResolvedValue({ ok: true, clientsProcessed: 2 });
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => err.mockRestore());

describe("asset-mapping documents route handlers", () => {
  it("every route returns 401 with no session and calls nothing", async () => {
    m.auth.mockResolvedValue(null);
    for (const run of Object.values(routes)) {
      const res = await run();
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    }
    expect([m.pdf, m.allPdf, m.drive, m.scan, m.writeAudit].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("every route returns 404 when the documents flag is off", async () => {
    signIn("ADMIN");
    m.docs.mockReturnValue(false);
    for (const run of Object.values(routes)) expect((await run()).status).toBe(404);
    expect([m.pdf, m.allPdf, m.drive, m.scan].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("every route rejects a cross-site request with 403 before reading the session", async () => {
    signIn("ADMIN");
    const cs = { "sec-fetch-site": "cross-site" };
    const results = [
      await householdPdf(req("GET", cs), ctx()), await allClientsPdf(req("GET", cs)),
      await saveToDrive(req("POST", cs), ctx()), await scan(req("POST", cs)),
    ];
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(m.auth).not.toHaveBeenCalled();
    expect((await scan(req("POST", { "sec-fetch-site": "same-origin" }))).status).toBe(200);
  });

  it("every route returns 503 when reading the session throws, and calls nothing", async () => {
    m.auth.mockRejectedValue(new Error("session store down"));
    for (const run of Object.values(routes)) expect((await run()).status).toBe(503);
    expect([m.pdf, m.allPdf, m.drive, m.scan, m.writeAudit].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("both PDF routes serve Admin and Operations", async () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      signIn(role);
      expect((await routes.householdPdf()).status).toBe(200);
      expect((await routes.allClientsPdf()).status).toBe(200);
    }
  });

  it("household PDF returns 403 outside the asset-mapping view roles before any pipeline call", async () => {
    for (const role of NO_VIEW_ROLES) {
      signIn(role);
      expect((await routes.householdPdf()).status).toBe(403);
    }
    expect(m.pdf).not.toHaveBeenCalled();
    expect(m.writeAudit).not.toHaveBeenCalled();
  });

  it("all-clients PDF returns 403 outside the asset-mapping view roles before any pipeline call", async () => {
    for (const role of NO_VIEW_ROLES) {
      signIn(role);
      expect((await routes.allClientsPdf()).status).toBe(403);
    }
    expect(m.allPdf).not.toHaveBeenCalled();
    expect(m.writeAudit).not.toHaveBeenCalled();
  });

  it.each(READ_ONLY_ROLES)("%s downloads both PDFs, audited under that user (ticket)", async (role) => {
    signIn(role, "read.only@example.invalid");
    const one = await routes.householdPdf();
    const all = await routes.allClientsPdf();
    expect([one.status, all.status]).toEqual([200, 200]);
    expect(one.headers.get("Content-Type")).toBe("application/pdf");
    expect(m.pdf).toHaveBeenCalledWith(BASE, HID);
    expect(m.allPdf).toHaveBeenCalledTimes(1);
    expect(m.writeAudit.mock.calls.map((c) => [c[1], c[2].action])).toEqual([
      [{ role, email: "read.only@example.invalid" }, "asset_map_documents.household_pdf"],
      [{ role, email: "read.only@example.invalid" }, "asset_map_documents.all_clients_pdf"],
    ]);
  });

  it("Save to Drive and manual scan return 403 outside Admin and Operations", async () => {
    for (const role of NOT_OPERATE_ROLES) {
      signIn(role);
      expect((await routes.saveToDrive()).status).toBe(403);
      expect((await routes.scan()).status).toBe(403);
    }
    expect(m.drive).not.toHaveBeenCalled();
    expect(m.scan).not.toHaveBeenCalled();
  });

  it("household PDF returns the bytes as an attachment and writes the audit row", async () => {
    signIn("OPERATIONS", "ops.person@example.invalid");
    const res = await routes.householdPdf();
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Synthetic_report.pdf"');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("%PDF-x");
    expect(m.pdf).toHaveBeenCalledWith(BASE, HID);
    expect(m.writeAudit).toHaveBeenCalledWith({ tx: true }, { role: "OPERATIONS", email: "ops.person@example.invalid" }, {
      action: "asset_map_documents.household_pdf", entityType: "asset_map_household", entityId: HID, detail: {},
    });
  });

  it("all-clients PDF returns the bytes and writes the audit row", async () => {
    signIn("ADMIN");
    const res = await routes.allClientsPdf();
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="all_clients_report.pdf"');
    expect(m.writeAudit.mock.calls[0][2]).toMatchObject({ action: "asset_map_documents.all_clients_pdf", entityId: null });
  });

  it("Save to Drive returns the file, the review instant, and the signed-in reviewer, and audits the review instant", async () => {
    signIn("OPERATIONS", "ops.person@example.invalid");
    const res = await routes.saveToDrive();
    expect(await res.json()).toEqual({
      filename: "Synthetic_report.pdf", webViewLink: "https://drive.example.test/f", reviewedAt: "2026-10-04T13:00:00", reviewer: "ops.person@example.invalid",
    });
    expect(m.writeAudit.mock.calls[0][2]).toEqual({
      action: "asset_map_documents.drive_save", entityType: "asset_map_household", entityId: HID, detail: { reviewedAt: "2026-10-04T13:00:00" },
    });
  });

  it("a pipeline failure returns 502 with the status and writes no PDF or Drive audit row", async () => {
    signIn("ADMIN");
    m.pdf.mockResolvedValue({ ok: false, reason: "failed", status: 500 });
    m.allPdf.mockResolvedValue({ ok: false, reason: "failed", status: null });
    m.drive.mockResolvedValue({ ok: false, reason: "failed", status: 502 });
    expect(await (await routes.householdPdf()).json()).toEqual({ error: "failed", status: 500 });
    expect(await (await routes.allClientsPdf()).json()).toEqual({ error: "failed", status: null });
    expect(await (await routes.saveToDrive()).json()).toEqual({ error: "failed", status: 502 });
    expect(m.writeAudit).not.toHaveBeenCalled();
  });

  it("an id that is not a pipeline id returns 400 before any pipeline call", async () => {
    signIn("ADMIN");
    expect((await householdPdf(req("GET"), ctx("../x"))).status).toBe(400);
    expect((await saveToDrive(req("POST"), ctx("not-a-uuid"))).status).toBe(400);
    expect(m.pdf).not.toHaveBeenCalled();
    expect(m.drive).not.toHaveBeenCalled();
  });

  it("an unset pipeline base URL returns 502 with no status", async () => {
    signIn("ADMIN");
    m.base.mockReturnValue(null);
    for (const run of Object.values(routes)) expect((await run()).status).toBe(502);
  });

  it("manual scan audits a finished scan with the client count", async () => {
    signIn("ADMIN");
    const res = await routes.scan();
    expect(await res.json()).toEqual({ clientsProcessed: 2 });
    expect(m.writeAudit.mock.calls[0][2]).toEqual({
      action: "asset_map_documents.scan", entityType: "asset_map_scan", entityId: null, detail: { outcome: "finished", clientsProcessed: 2 },
    });
  });

  it("manual scan audits a failed scan and passes the detail through", async () => {
    signIn("OPERATIONS");
    m.scan.mockResolvedValue({ ok: false, reason: "failed", status: 500, detail: "Scan failed. Check server logs for details." });
    const res = await routes.scan();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "failed", status: 500, detail: "Scan failed. Check server logs for details." });
    expect(m.writeAudit.mock.calls[0][2]).toMatchObject({ detail: { outcome: "failed", clientsProcessed: null } });
  });

  it("a busy scan returns 409 and is not audited", async () => {
    signIn("ADMIN");
    m.scan.mockResolvedValue({ ok: false, reason: "busy" });
    const res = await routes.scan();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "busy" });
    expect(m.writeAudit).not.toHaveBeenCalled();
  });

  it("a failed audit write logs a static marker and still returns the result", async () => {
    signIn("ADMIN");
    m.writeAudit.mockRejectedValue(new Error("db down person@example.invalid"));
    expect((await routes.saveToDrive()).status).toBe(200);
    expect((await routes.scan()).status).toBe(200);
    expect(err.mock.calls.map((c) => c.join(" "))).toEqual([
      "[asset-mapping] documents_audit_failed", "[asset-mapping] documents_audit_failed",
    ]);
  });
});

describe("loadAssetMapDriveSaveReviewer", () => {
  it("reads the latest Drive-save audit row for Admin and Operations under the user scope", async () => {
    signIn("OPERATIONS", "ops.person@example.invalid");
    m.readAudit.mockResolvedValue({ reviewedAt: "2026-10-04T13:00:00", reviewer: "ops.person@example.invalid" });
    expect(await loadAssetMapDriveSaveReviewer(HID)).toEqual({ reviewedAt: "2026-10-04T13:00:00", reviewer: "ops.person@example.invalid" });
    expect(m.scope.mock.calls[0][0]).toEqual({ role: "OPERATIONS", email: "ops.person@example.invalid" });
    expect(m.readAudit).toHaveBeenCalledWith({ tx: true }, HID);
  });

  it("returns null without reading for another role, the flag off, or a bad id", async () => {
    for (const role of ["CLIENT_SERVICE", "ADVISOR", "VIEWER"]) {
      signIn(role);
      expect(await loadAssetMapDriveSaveReviewer(HID)).toBeNull();
    }
    signIn("ADMIN");
    expect(await loadAssetMapDriveSaveReviewer("x")).toBeNull();
    m.docs.mockReturnValue(false);
    expect(await loadAssetMapDriveSaveReviewer(HID)).toBeNull();
    expect(m.readAudit).not.toHaveBeenCalled();
  });

  it("returns null and logs a static marker when the read fails", async () => {
    signIn("ADMIN");
    m.readAudit.mockRejectedValue(new Error("rls"));
    expect(await loadAssetMapDriveSaveReviewer(HID)).toBeNull();
    expect(err.mock.calls.map((c) => c.join(" "))).toEqual(["[asset-mapping] documents_reviewer_unavailable"]);
  });
});
