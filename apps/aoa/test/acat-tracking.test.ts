import { describe, it, expect } from "vitest";
import {
  acatPhase,
  buildAcatTracking,
  type AcatStatusGroup,
} from "@/lib/data/acat-tracking";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import type { AcatListRow, AcatListAssetMap } from "@/lib/data/acat-status";

// --- fixture ----------------------------------------------------------------

function listRow(
  over: Partial<AcatListRow> & { acatTransferId: string },
): AcatListRow {
  const assetMap: AcatListAssetMap = over.assetMap ?? {
    total: 10,
    mapped: 10,
    unmapped: 0,
    pending: 0,
    expected: 10,
  };
  return {
    // Record id defaults to the acatTransferId for convenience; a UUID-less
    // fixture passes an explicit `id` alongside an empty acatTransferId.
    id: over.id ?? over.acatTransferId,
    acatTransferId: over.acatTransferId,
    clientName: over.clientName ?? "Client",
    controlNumber: over.controlNumber ?? null,
    direction: over.direction ?? "Incoming",
    type: over.type ?? "Full account transfer",
    accountType: over.accountType ?? "Brokerage",
    status: "status" in over ? (over.status ?? null) : "Submitted",
    transferringContra: over.transferringContra ?? "Fidelity",
    statementAmount: over.statementAmount ?? 1000,
    acatDate: over.acatDate ?? "2026-07-10",
    lastActivityAt:
      "lastActivityAt" in over
        ? (over.lastActivityAt ?? null)
        : "2026-07-10T00:00:00.000Z",
    apexAccountId: over.apexAccountId ?? "****1111",
    statementAccountNumber: over.statementAccountNumber ?? "****2222",
    dtccNumber: over.dtccNumber ?? "****3333",
    assetMap,
  };
}

const labels = (groups: AcatStatusGroup[]) => groups.map((g) => g.label);

// --- ordering phase (catalog-backed, ticket) ------------------------------
// acatPhase now resolves the RAW tracker enum value through the canonical status
// catalog, so the assertions use the exact raw enum strings the tracker returns.

describe("acatPhase", () => {
  it("classifies statuses 1–11 as in-flight", () => {
    for (const s of [
      "WaitingForApex",
      "PendingAccountOpening",
      "WaitingOnClient",
      "AcatReceived",
      "ToCome",
      "Submitted",
      "PendingReview",
      "PendingContraResponse",
      "Accepted",
      "PendingSettlement",
      "PendingBookkeeping",
    ]) {
      expect(acatPhase(s)).toBe("in_flight");
    }
  });

  it("classifies Rejected/Purged/Canceled/Deferred as the needs-attention band", () => {
    for (const s of ["Rejected", "Purged", "Canceled", "Deferred"]) {
      expect(acatPhase(s)).toBe("attention");
    }
  });

  it("classifies Completed as the completed band", () => {
    expect(acatPhase("Completed")).toBe("completed");
  });

  it("puts a null/blank or unmapped status in the attention band (visible, not dropped)", () => {
    expect(acatPhase(null)).toBe("attention");
    expect(acatPhase("")).toBe("attention");
    expect(acatPhase("SomeBrandNewStatus")).toBe("attention");
  });

  it("keeps 'PendingSettlement' (raw) in-flight, distinct from Completed", () => {
    expect(acatPhase("PendingSettlement")).toBe("in_flight");
    expect(acatPhase("Completed")).toBe("completed");
  });
});

// --- grouping / ordering ----------------------------------------------------

describe("buildAcatTracking — grouping & ordering", () => {
  it("buckets rows by their friendly status label (raw enum → label)", () => {
    const { groups } = buildAcatTracking([
      listRow({ acatTransferId: "A1", status: "Submitted" }),
      listRow({ acatTransferId: "A2", status: "Submitted" }),
      listRow({ acatTransferId: "A3", status: "Accepted" }),
    ]);
    const submitted = groups.find((g) => g.label === "Submitted");
    expect(submitted?.count).toBe(2);
    expect(submitted?.rows.map((r) => r.acatTransferId).sort()).toEqual([
      "A1",
      "A2",
    ]);
    expect(groups.find((g) => g.label === "Accepted")?.count).toBe(1);
  });

  it("maps a raw PascalCase enum value to its friendly group label", () => {
    const { groups } = buildAcatTracking([
      listRow({ acatTransferId: "P1", status: "PendingSettlement" }),
      listRow({ acatTransferId: "T1", status: "ToCome" }),
      listRow({ acatTransferId: "B1", status: "PendingBookkeeping" }),
      listRow({ acatTransferId: "R1", status: "AcatReceived" }),
    ]);
    expect(labels(groups)).toContain("Pending Settlement");
    expect(labels(groups)).toContain("To Come");
    expect(labels(groups)).toContain("Pending Bookkeeping");
    expect(labels(groups)).toContain("ACAT Received");
    // The raw value must NOT leak into a group label.
    expect(labels(groups)).not.toContain("PendingSettlement");
  });

  it("orders groups in-flight → attention → completed, then by canonical lifecycle order", () => {
    const { groups } = buildAcatTracking([
      listRow({ acatTransferId: "C1", status: "Completed" }),
      // Canceled is an attention-band terminal that (unlike Rejected) is still
      // shown on this tab, so it exercises the band ordering.
      listRow({ acatTransferId: "CX1", status: "Canceled" }),
      listRow({ acatTransferId: "S1", status: "Submitted" }),
      listRow({ acatTransferId: "AC1", status: "Accepted" }),
      listRow({ acatTransferId: "PS1", status: "PendingSettlement" }),
    ]);
    // In-flight band by canonical order: Submitted(6) < Accepted(9) <
    // PendingSettlement(10); then Canceled(15, attention); then Completed(12,
    // completed band — last, as the page has always banded terminals).
    expect(labels(groups)).toEqual([
      "Submitted",
      "Accepted",
      "Pending Settlement",
      "Canceled",
      "Completed",
    ]);
  });

  it("carries the catalog tone per group (green/amber/red/gray)", () => {
    const { groups } = buildAcatTracking([
      listRow({ acatTransferId: "A1", status: "Accepted" }),
      listRow({ acatTransferId: "S1", status: "Submitted" }),
      // Canceled also carries the red "rejected" tone and (unlike Rejected) is
      // still shown here.
      listRow({ acatTransferId: "CX1", status: "Canceled" }),
    ]);
    expect(groups.find((g) => g.label === "Accepted")?.tone).toBe("accepted");
    expect(groups.find((g) => g.label === "Submitted")?.tone).toBe("submitted");
    expect(groups.find((g) => g.label === "Canceled")?.tone).toBe("rejected");
  });

  it("sorts rows most-recent-first within a group (lastActivityAt, then acatDate)", () => {
    const { groups } = buildAcatTracking([
      listRow({ acatTransferId: "OLD", status: "Submitted", lastActivityAt: "2026-07-10T00:00:00.000Z" }),
      listRow({ acatTransferId: "NEW", status: "Submitted", lastActivityAt: "2026-07-14T00:00:00.000Z" }),
      listRow({ acatTransferId: "MID", status: "Submitted", lastActivityAt: "2026-07-12T00:00:00.000Z" }),
    ]);
    expect(groups[0].rows.map((r) => r.acatTransferId)).toEqual([
      "NEW",
      "MID",
      "OLD",
    ]);
  });

  it("buckets a null/blank status into 'Unknown status' (nothing dropped)", () => {
    const { groups, summary } = buildAcatTracking([
      listRow({ acatTransferId: "A1", status: null }),
      listRow({ acatTransferId: "A2", status: "" }),
    ]);
    const unknown = groups.find((g) => g.label === "Unknown status");
    expect(unknown?.count).toBe(2);
    expect(unknown?.tone).toBe("neutral");
    expect(summary.total).toBe(2);
  });

  it("keeps an UNMAPPED raw status visible under its own humanized label", () => {
    const { groups, summary } = buildAcatTracking([
      listRow({ acatTransferId: "U1", status: "SomeBrandNewStatus" }),
      listRow({ acatTransferId: "S1", status: "Submitted" }),
    ]);
    const unknown = groups.find((g) => g.label === "Some Brand New Status");
    expect(unknown?.count).toBe(1);
    expect(unknown?.tone).toBe("neutral");
    // Nothing dropped: both the known and the unknown row survive.
    expect(summary.total).toBe(2);
    // The unmapped status sorts into the attention band, after the known
    // in-flight "Submitted" group.
    expect(labels(groups)).toEqual(["Submitted", "Some Brand New Status"]);
  });
});

// --- UUID-less (legacy/manual) rows -----------------------------------------
// A tracker record may have NO transfer UUID (acatTransferId empty) — a
// legacy/manual entry. fetchAcatList keeps it (keyed by record id); it must
// group + render here exactly like any other row.

describe("buildAcatTracking — UUID-less rows", () => {
  it("groups a UUID-less PendingSettlement row under 'Pending Settlement', keyed by id", () => {
    const { groups, summary } = buildAcatTracking([
      listRow({ id: "rec-manual", acatTransferId: "", status: "PendingSettlement", clientName: "Obie Armstrong" }),
    ]);
    const pending = groups.find((g) => g.label === "Pending Settlement");
    expect(pending?.count).toBe(1);
    const row = pending!.rows[0];
    // The stable identity is the record id, not the (empty) acatTransferId.
    expect(row.id).toBe("rec-manual");
    expect(row.acatTransferId).toBe("");
    expect(row.clientName).toBe("Obie Armstrong");
    // Never dropped: it counts as a real (un-linked) record.
    expect(summary.total).toBe(1);
    expect(summary.unlinked).toBe(1);
  });
});

// --- hidden terminal statuses (Rejected) ------------------------------------
// Rejected is TERMINAL and deliberately NOT shown on the AOA ACAT Tracking tab
// (display-level filter; the tracker still returns it and the external link
// remains the place to review terminals). It must leave the grouped list AND
// every summary count, while live/in-flight rows (incl. a UUID-less one) stay.

describe("buildAcatTracking — hides terminal Rejected", () => {
  it("produces no 'Rejected' group and does not count Rejected; live rows remain", () => {
    const { groups, summary } = buildAcatTracking([
      listRow({ acatTransferId: "R1", status: "Rejected" }),
      listRow({ acatTransferId: "R2", status: "Rejected" }),
      listRow({ acatTransferId: "S1", status: "Submitted" }),
      listRow({ id: "rec-manual", acatTransferId: "", status: "PendingSettlement" }),
    ]);
    // No Rejected group renders at all.
    expect(labels(groups)).not.toContain("Rejected");
    // The live in-flight rows — including the UUID-less Pending Settlement — do.
    expect(labels(groups).sort()).toEqual(["Pending Settlement", "Submitted"]);
    // Rejected rows inflate no count.
    expect(summary.total).toBe(2);
    expect(summary.inFlight).toBe(2);
    expect(summary.attention).toBe(0);
    expect(summary.needsAttention).toBe(0);
  });

  it("still counts a genuine (non-Rejected) mismatch under needs-attention", () => {
    const { summary } = buildAcatTracking([
      listRow({ acatTransferId: "R1", status: "Rejected" }),
      listRow({
        acatTransferId: "M1",
        status: "Accepted",
        assetMap: { total: 4, mapped: 2, unmapped: 2, pending: 0, expected: 4 },
      }),
    ]);
    expect(summary.total).toBe(1); // Rejected excluded
    expect(summary.needsAttention).toBe(1); // the mismatch survives
  });
});

// --- linkage ----------------------------------------------------------------

describe("buildAcatTracking — linkage", () => {
  it("marks rows linked (with transferId) when a visible transfer matches", () => {
    const linked = new Map<string, string>([["A1", "T-100"]]);
    const { groups, summary } = buildAcatTracking(
      [
        listRow({ acatTransferId: "A1", status: "Accepted" }),
        listRow({ acatTransferId: "A2", status: "Accepted" }),
      ],
      linked,
    );
    const rows = groups[0].rows;
    const a1 = rows.find((r) => r.acatTransferId === "A1")!;
    const a2 = rows.find((r) => r.acatTransferId === "A2")!;
    expect(a1.linked).toBe(true);
    expect(a1.transferId).toBe("T-100");
    expect(a2.linked).toBe(false);
    expect(a2.transferId).toBeNull();
    expect(summary.linked).toBe(1);
    expect(summary.unlinked).toBe(1);
  });

  it("treats every row as un-linked when no map is provided", () => {
    const { summary } = buildAcatTracking([
      listRow({ acatTransferId: "A1", status: "Accepted" }),
    ]);
    expect(summary.linked).toBe(0);
    expect(summary.unlinked).toBe(1);
  });

  it("marks a UUID-less ('N/A') row linked via the record-id map leg, moving the summary counts", () => {
    // The record-id leg is what makes a freshly linked N/A record show
    // "Linked" + "View transfer →" immediately (record-id linking).
    const byRecord = new Map<string, string>([["rec-manual-hayes", "T-200"]]);
    const { groups, summary } = buildAcatTracking(
      [
        listRow({ id: "rec-manual-hayes", acatTransferId: "N/A", status: "Accepted" }),
        listRow({ id: "rec-manual-armstrong", acatTransferId: "N/A", status: "Accepted" }),
      ],
      new Map(),
      byRecord,
    );
    const rows = groups[0].rows;
    const hayes = rows.find((r) => r.id === "rec-manual-hayes")!;
    const armstrong = rows.find((r) => r.id === "rec-manual-armstrong")!;
    expect(hayes.linked).toBe(true);
    expect(hayes.transferId).toBe("T-200");
    expect(armstrong.linked).toBe(false);
    expect(armstrong.transferId).toBeNull();
    expect(summary.linked).toBe(1);
    expect(summary.unlinked).toBe(1);
  });

  it("record-id map takes PRECEDENCE when a row matches both maps", () => {
    const linked = new Map<string, string>([["A1", "T-uuid"]]);
    const byRecord = new Map<string, string>([["rec-a1", "T-record"]]);
    const { groups } = buildAcatTracking(
      [listRow({ id: "rec-a1", acatTransferId: "A1", status: "Accepted" })],
      linked,
      byRecord,
    );
    expect(groups[0].rows[0].transferId).toBe("T-record");
  });
});

// --- needs-attention + summary ----------------------------------------------

describe("buildAcatTracking — needs-attention & summary counts", () => {
  it("flags needsAttention on a red-tone status OR a position mismatch (reused signals)", () => {
    const { groups } = buildAcatTracking([
      // Canceled carries the red "rejected" tone (and is still shown, unlike
      // Rejected), so it exercises the tone-based needs-attention signal.
      listRow({ acatTransferId: "CX1", status: "Canceled" }),
      listRow({
        acatTransferId: "M1",
        status: "Accepted",
        assetMap: { total: 4, mapped: 2, unmapped: 2, pending: 0, expected: 4 },
      }),
      listRow({ acatTransferId: "OK", status: "Accepted" }),
    ]);
    const canceled = groups.find((g) => g.label === "Canceled")!.rows[0];
    const accepted = groups.find((g) => g.label === "Accepted")!.rows;
    expect(canceled.needsAttention).toBe(true);
    expect(accepted.find((r) => r.acatTransferId === "M1")!.needsAttention).toBe(true);
    expect(accepted.find((r) => r.acatTransferId === "OK")!.needsAttention).toBe(false);
  });

  it("computes summary counts by phase + needs-attention + total", () => {
    const { summary } = buildAcatTracking([
      listRow({ acatTransferId: "S1", status: "Submitted" }),
      listRow({ acatTransferId: "A1", status: "Accepted" }),
      // Canceled is an attention-band terminal still shown on this tab.
      listRow({ acatTransferId: "CX1", status: "Canceled" }),
      listRow({ acatTransferId: "C1", status: "Completed" }),
      listRow({
        acatTransferId: "M1",
        status: "Accepted",
        assetMap: { total: 6, mapped: 5, unmapped: 1, pending: 0, expected: 6 },
      }),
    ]);
    expect(summary.total).toBe(5);
    expect(summary.inFlight).toBe(3); // Submitted + 2 Accepted
    expect(summary.attention).toBe(1); // Canceled
    expect(summary.completed).toBe(1); // Completed
    expect(summary.needsAttention).toBe(2); // Canceled (red tone) + the mismatch
  });

  it("returns no groups and an all-zero summary for an empty/degraded list", () => {
    const { groups, summary } = buildAcatTracking([]);
    expect(groups).toEqual([]);
    expect(summary).toEqual({
      total: 0,
      inFlight: 0,
      attention: 0,
      completed: 0,
      needsAttention: 0,
      linked: 0,
      unlinked: 0,
    });
  });
});

// --- page role gate ---------------------------------------------------------
// The /acat-tracking page and its nav item reuse the firm-wide ACAT gate
// (canSeeUnlinkedAcats = ADMIN / OPERATIONS). This documents that contract for
// the page (the mockup suggests Client Service too — left for the owner).

describe("ACAT Tracking page gate (canSeeUnlinkedAcats)", () => {
  it("allows ADMIN and OPERATIONS", () => {
    expect(canSeeUnlinkedAcats("ADMIN")).toBe(true);
    expect(canSeeUnlinkedAcats("OPERATIONS")).toBe(true);
  });
  it("denies ADVISOR, CLIENT_SERVICE, VIEWER and unknown roles", () => {
    for (const r of ["ADVISOR", "CLIENT_SERVICE", "VIEWER", "", null, undefined]) {
      expect(canSeeUnlinkedAcats(r)).toBe(false);
    }
  });
});
