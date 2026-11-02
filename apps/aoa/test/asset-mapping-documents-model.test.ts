import { describe, expect, it } from "vitest";
import {
  documentsReducer,
  effectiveReview,
  failureAlert,
  initialDocumentsState,
  isReviewCurrent,
  resolveReviewer,
  reviewInstantKey,
  reviewedLabel,
  scanMessageFor,
  visibleAlert,
  visibleNotice,
} from "@/components/asset-mapping/workspace/documents/documents-model";

const HID = "11111111-1111-4111-8111-111111111111";
const live = (reviewedAt: string | null, updatedAt: string | null, reviewedBy: string | null = "sa@example.invalid") => ({ reviewedAt, reviewedBy, updatedAt });

describe("asset-mapping documents model", () => {
  it("reviewInstantKey matches the same instant across offsets and keeps microseconds", () => {
    expect(reviewInstantKey("2026-10-04T13:00:00.123456-04:00")).toBe(reviewInstantKey("2026-10-04T17:00:00.123456+00:00"));
    expect(reviewInstantKey("2026-10-04T17:00:00.123456Z")).not.toBe(reviewInstantKey("2026-10-04T17:00:00.123457Z"));
    expect(reviewInstantKey("2026-10-04T17:00:00")).toBe(reviewInstantKey("2026-10-04T17:00:00.000000Z"));
    expect(reviewInstantKey("not a time")).toBeNull();
    expect(reviewInstantKey(null)).toBeNull();
  });

  it("a review is current only when it is no older than the last update", () => {
    expect(isReviewCurrent(live("2026-10-04T13:00:00Z", "2026-10-04T12:00:00Z"))).toBe(true);
    expect(isReviewCurrent(live("2026-10-04T13:00:00Z", "2026-10-04T13:00:00Z"))).toBe(true);
    expect(isReviewCurrent(live("2026-10-04T13:00:00Z", "2026-10-04T14:00:00Z"))).toBe(false);
    expect(isReviewCurrent(live("2026-10-04T13:00:00Z", null))).toBe(true);
    expect(isReviewCurrent(live(null, "2026-10-04T14:00:00Z"))).toBe(false);
  });

  it("unknown review state is not current, so Mark as Completed stays enabled", () => {
    expect(effectiveReview(HID, null, null, null)).toEqual({ current: false, reviewedAt: null, reviewer: null });
    expect(isReviewCurrent(null)).toBe(false);
  });

  it("the reviewer comes from the audit row only on an exact review-time match", () => {
    const review = live("2026-10-04T13:00:00.123456-04:00", null);
    expect(resolveReviewer(review, { reviewedAt: "2026-10-04T17:00:00.123456+00:00", reviewer: "ops.person@example.invalid" })).toBe("ops.person@example.invalid");
    expect(resolveReviewer(review, { reviewedAt: "2026-10-04T17:00:00.123455+00:00", reviewer: "ops.person@example.invalid" })).toBe("sa@example.invalid");
    expect(resolveReviewer(review, null)).toBe("sa@example.invalid");
    expect(resolveReviewer(live(null, null), { reviewedAt: "2026-10-04T17:00:00Z", reviewer: "x" })).toBeNull();
  });

  it("a Drive save in this session wins for its own household only", () => {
    const saved = { householdId: HID, reviewedAt: "2026-10-04T13:00:00Z", reviewer: "ops.person@example.invalid" };
    expect(effectiveReview(HID, live(null, "2026-10-04T12:00:00Z"), saved, null)).toEqual({ current: true, reviewedAt: saved.reviewedAt, reviewer: saved.reviewer });
    expect(effectiveReview("22222222-2222-4222-8222-222222222222", null, saved, null).reviewedAt).toBeNull();
  });

  it("reviewedLabel shortens the email and formats in New York time", () => {
    expect(reviewedLabel("ops.person@example.invalid", "2026-10-04T17:00:00Z")).toBe("Reviewed by ops.person at Oct 4, 1:00 PM");
    expect(reviewedLabel(null, "2026-10-04T17:00:00Z")).toBe("Reviewed by ops at Oct 4, 1:00 PM");
  });

  it("failure alerts name the action and the status", () => {
    expect(failureAlert("pdf", 500)).toBe("PDF export failed (500)");
    expect(failureAlert("allPdf", null)).toBe("Export failed (no response)");
    expect(failureAlert("saveToDrive", 403, true)).toBe("Save to Drive failed (not allowed)");
    expect(failureAlert("markCompleted", 502)).toBe("Mark as Completed failed (502)");
  });

  it("a busy scan shows exactly A scan is already in progress. and each other outcome its own text", () => {
    expect(scanMessageFor({ kind: "finished", clientsProcessed: 3 })).toEqual({ text: "Scan finished — 3 client(s) processed.", variant: "success" });
    expect(scanMessageFor({ kind: "busy" })).toEqual({ text: "A scan is already in progress.", variant: "warn" });
    expect(scanMessageFor({ kind: "forbidden" }).variant).toBe("error");
    expect(scanMessageFor({ kind: "failed", status: 500, detail: "Scan failed. Check server logs for details." }).text).toBe("Scan failed. Check server logs for details.");
    expect(scanMessageFor({ kind: "failed", status: 500, detail: null }).text).toBe("Scan failed (500)");
    expect(scanMessageFor({ kind: "failed", status: null, detail: null }).text).toBe("Scan request failed");
  });

  it("start marks the action busy and clears the alert, except a scan keeps the alert", () => {
    const withAlert = { ...initialDocumentsState(), alert: { householdId: HID, text: "PDF export failed (500)" } };
    const pdf = documentsReducer(withAlert, { type: "start", kind: "pdf" });
    expect(pdf.busy.pdf).toBe(true);
    expect(pdf.alert).toBeNull();
    expect(documentsReducer(withAlert, { type: "start", kind: "scan" }).alert?.text).toBe("PDF export failed (500)");
  });

  it("a failure clears busy and sets the alert until dismissed", () => {
    let s = documentsReducer(initialDocumentsState(), { type: "start", kind: "saveToDrive" });
    s = documentsReducer(s, { type: "failed", kind: "saveToDrive", householdId: HID, text: "Save to Drive failed (502)" });
    expect(s.busy.saveToDrive).toBe(false);
    expect(visibleAlert(s, HID)).toBe("Save to Drive failed (502)");
    expect(documentsReducer(s, { type: "dismissAlert" }).alert).toBeNull();
  });

  it("driveSaved records the notice and the saved review", () => {
    const s = documentsReducer(initialDocumentsState(), {
      type: "driveSaved", kind: "markCompleted", householdId: HID, filename: "f.pdf",
      webViewLink: "https://drive.example.test/f", reviewedAt: "2026-10-04T13:00:00Z", reviewer: "ops.person@example.invalid",
    });
    expect(s.notice).toEqual({ householdId: HID, filename: "f.pdf", webViewLink: "https://drive.example.test/f", reviewer: "ops.person@example.invalid" });
    expect(s.saved).toEqual({ householdId: HID, reviewedAt: "2026-10-04T13:00:00Z", reviewer: "ops.person@example.invalid" });
    expect(documentsReducer(s, { type: "clearNotice", householdId: HID }).notice).toBeNull();
  });

  it("a Drive save that finishes after a household switch shows no notice on the new household", () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    let s = documentsReducer(initialDocumentsState(), { type: "start", kind: "saveToDrive" });
    s = documentsReducer(s, { type: "reset" });
    s = documentsReducer(s, {
      type: "driveSaved", kind: "saveToDrive", householdId: HID, filename: "f.pdf",
      webViewLink: "https://drive.example.test/f", reviewedAt: "2026-10-04T13:00:00Z", reviewer: "ops.person@example.invalid",
    });
    expect(visibleNotice(s, OTHER)).toBeNull();
    expect(visibleNotice(s, HID)?.filename).toBe("f.pdf");
    expect(documentsReducer(s, { type: "clearNotice", householdId: OTHER }).notice?.householdId).toBe(HID);
  });

  it("a failure that arrives after a household switch shows no alert on the new household", () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    let s = documentsReducer(initialDocumentsState(), { type: "start", kind: "pdf" });
    s = documentsReducer(s, { type: "reset" });
    s = documentsReducer(s, { type: "failed", kind: "pdf", householdId: HID, text: "PDF export failed (502)" });
    expect(visibleAlert(s, OTHER)).toBeNull();
    expect(visibleAlert(s, HID)).toBe("PDF export failed (502)");
    s = documentsReducer(s, { type: "failed", kind: "allPdf", householdId: null, text: "Export failed (502)" });
    expect(visibleAlert(s, OTHER)).toBe("Export failed (502)");
  });

  it("reset on a household change keeps a running scan and all-clients export", () => {
    let s = documentsReducer(initialDocumentsState(), { type: "start", kind: "scan" });
    s = documentsReducer(s, { type: "start", kind: "allPdf" });
    s = documentsReducer(s, { type: "start", kind: "pdf" });
    s = { ...s, alert: { householdId: HID, text: "x" }, scanMessage: { text: "y", variant: "warn" } };
    const r = documentsReducer(s, { type: "reset" });
    expect(r.busy).toEqual({ pdf: false, allPdf: true, markCompleted: false, saveToDrive: false, scan: true });
    expect(r.alert).toBeNull();
    expect(r.scanMessage).toEqual({ text: "y", variant: "warn" });
  });
});
