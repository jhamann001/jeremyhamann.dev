import { describe, it, expect } from "vitest";
import {
  buildAcatChipMap,
  filterAcatChipMapForVisibleRows,
  canSeeUnlinkedAcats,
  acatSectionOutcome,
  acatToneKind,
  acatMapSummary,
  isLinkableAcatTransferId,
} from "@/lib/data/acat-lane";
import type { AcatListRow, AcatListAssetMap } from "@/lib/data/acat-status";

// --- fixtures ---------------------------------------------------------------

function listRow(over: Partial<AcatListRow> & { acatTransferId: string }): AcatListRow {
  const assetMap: AcatListAssetMap = over.assetMap ?? {
    total: 10,
    mapped: 10,
    unmapped: 0,
    pending: 0,
    expected: 10,
  };
  return {
    id: over.id ?? over.acatTransferId,
    acatTransferId: over.acatTransferId,
    clientName: over.clientName ?? "Client",
    controlNumber: over.controlNumber ?? null,
    direction: over.direction ?? "Incoming",
    type: over.type ?? "Full account transfer",
    accountType: over.accountType ?? "Brokerage",
    // Honor an explicit null/"" (so the no-status skip is testable); only
    // default when the key is absent.
    status: "status" in over ? (over.status ?? null) : "Accepted",
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

// --- role gate --------------------------------------------------------------

describe("canSeeUnlinkedAcats", () => {
  it("is true only for firm-wide roles (ADMIN / OPERATIONS)", () => {
    for (const r of ["ADMIN", "OPERATIONS"]) {
      expect(canSeeUnlinkedAcats(r)).toBe(true);
    }
    // HEAD_OF_ADVISORY is no longer a live role (PR #138 folds it into
    // OPERATIONS at the Okta layer) — it must fail closed like VIEWER/ADVISOR.
    for (const r of [
      "HEAD_OF_ADVISORY",
      "ADVISOR",
      "CLIENT_SERVICE",
      "VIEWER",
      "",
      null,
      undefined,
    ]) {
      expect(canSeeUnlinkedAcats(r)).toBe(false);
    }
  });
});

// --- status → tone ----------------------------------------------------------

describe("acatToneKind", () => {
  it("classifies the mockup's status vocabulary", () => {
    expect(acatToneKind("Accepted")).toBe("accepted");
    expect(acatToneKind("Submitted")).toBe("submitted");
    expect(acatToneKind("Pending review")).toBe("submitted");
    expect(acatToneKind("Rejected")).toBe("rejected");
    expect(acatToneKind("CANCELLED")).toBe("rejected");
    expect(acatToneKind("Something else")).toBe("neutral");
    expect(acatToneKind(null)).toBe("neutral");
  });

  it("maps Accepted and Completed to the same tone (green)", () => {
    expect(acatToneKind("Accepted")).toBe("accepted");
    expect(acatToneKind("Completed")).toBe("accepted");
  });
});

// --- asset-map summary ------------------------------------------------------

describe("acatMapSummary", () => {
  it("shows 'N / M mapped' when fully mapped and clean", () => {
    const s = acatMapSummary({ total: 41, mapped: 41, unmapped: 0, pending: 0, expected: 41 });
    expect(s).toEqual({ text: "41 / 41 mapped", warning: false });
  });
  it("shows '{n} mismatch' (warning) when unmapped/pending exist", () => {
    const s = acatMapSummary({ total: 4, mapped: 2, unmapped: 2, pending: 0, expected: 4 });
    expect(s.warning).toBe(true);
    expect(s.text).toBe("2 mismatch");
  });
  it("counts pending as an exception", () => {
    const s = acatMapSummary({ total: 12, mapped: 9, unmapped: 0, pending: 3, expected: 12 });
    expect(s).toEqual({ text: "3 mismatch", warning: true });
  });
  it("treats null counts as zero without crashing", () => {
    const s = acatMapSummary({ total: null, mapped: null, unmapped: null, pending: null, expected: null });
    expect(s).toEqual({ text: "0 / 0 mapped", warning: false });
  });
});

// --- transfer-centric chip map (step 1) -------------------------------------

describe("buildAcatChipMap", () => {
  it("keys a chip by acatTransferId with the verbatim status and reused tone", () => {
    const map = buildAcatChipMap([
      listRow({ acatTransferId: "A1", status: "Accepted" }),
      listRow({ acatTransferId: "A2", status: "Submitted" }),
    ]);
    expect(Object.keys(map).sort()).toEqual(["A1", "A2"]);
    expect(map.A1).toEqual({
      status: "Accepted",
      tone: "accepted",
      needsAttention: false,
    });
    expect(map.A2.tone).toBe("submitted");
    expect(map.A2.needsAttention).toBe(false);
  });

  it("flags needsAttention when the ACAT is rejected (tone red)", () => {
    const map = buildAcatChipMap([
      listRow({ acatTransferId: "A1", status: "Rejected" }),
    ]);
    expect(map.A1.tone).toBe("rejected");
    expect(map.A1.needsAttention).toBe(true);
  });

  it("also treats a cancelled ACAT as rejected/attention", () => {
    const map = buildAcatChipMap([
      listRow({ acatTransferId: "A1", status: "Cancelled" }),
    ]);
    expect(map.A1.tone).toBe("rejected");
    expect(map.A1.needsAttention).toBe(true);
  });

  it("flags needsAttention on a POSITION MISMATCH even when the status tone is green", () => {
    // Accepted (green tone) but the asset map has unmapped positions → the chip
    // must still raise attention (reuses acatMapSummary's warning signal).
    const map = buildAcatChipMap([
      listRow({
        acatTransferId: "A1",
        status: "Accepted",
        assetMap: { total: 4, mapped: 2, unmapped: 2, pending: 0, expected: 4 },
      }),
    ]);
    expect(map.A1.tone).toBe("accepted");
    expect(map.A1.needsAttention).toBe(true);
  });

  it("no attention when accepted and the asset map is clean", () => {
    const map = buildAcatChipMap([
      listRow({
        acatTransferId: "A1",
        status: "Accepted",
        assetMap: { total: 8, mapped: 8, unmapped: 0, pending: 0, expected: 8 },
      }),
    ]);
    expect(map.A1.needsAttention).toBe(false);
  });

  it("skips rows with no live status (no meaningful chip)", () => {
    const map = buildAcatChipMap([
      listRow({ acatTransferId: "A1", status: null }),
      listRow({ acatTransferId: "A2", status: "" }),
      listRow({ acatTransferId: "A3", status: "Submitted" }),
    ]);
    expect(Object.keys(map)).toEqual(["A3"]);
  });

  it("never keys a chip by a placeholder acatTransferId — such rows key by RECORD id only", () => {
    const map = buildAcatChipMap([
      // "N/A"/"Manual" are placeholders — they must NOT key a chip (else a
      // transfer storing "N/A" renders a chip from the wrong newest-"N/A"
      // row); the row's own record id still keys its chip.
      listRow({ id: "rec-1", acatTransferId: "N/A", status: "Accepted" }),
      listRow({ id: "rec-2", acatTransferId: "Manual", status: "Submitted" }),
      listRow({ id: "rec-3", acatTransferId: "A2", status: "Accepted" }),
    ]);
    expect(Object.keys(map).sort()).toEqual(["A2", "rec-1", "rec-2", "rec-3"]);
    expect(map["N/A"]).toBeUndefined();
    expect(map.Manual).toBeUndefined();
  });

  it("keys every status-carrying row by its RECORD id (the D6 record-id-only board chip)", () => {
    // A record-id-only linked transfer (UUID-less "N/A" ACAT) stores only
    // acat_record_id — the board must find its chip under that key.
    const map = buildAcatChipMap([
      listRow({ id: "rec-manual-hayes", acatTransferId: "N/A", status: "Submitted" }),
    ]);
    expect(map["rec-manual-hayes"]).toEqual({
      status: "Submitted",
      tone: "submitted",
      needsAttention: false,
    });
  });

  it("keys a row with a REAL uuid by BOTH ids, sharing one chip", () => {
    const map = buildAcatChipMap([
      listRow({
        id: "rec-lee-8",
        acatTransferId: "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
        status: "Accepted",
      }),
    ]);
    expect(Object.keys(map).sort()).toEqual([
      "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      "rec-lee-8",
    ]);
    expect(map["rec-lee-8"]).toBe(map["1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"]);
  });

  it("builds a chip for a residual short-but-real id (e.g. 'ACT-RES-2')", () => {
    // Short ids are REAL, linkable tracker ids — only known placeholders are
    // refused, so a residual row still gets its chip.
    const map = buildAcatChipMap([
      listRow({ acatTransferId: "ACT-RES-2", status: "Submitted" }),
    ]);
    expect(Object.keys(map)).toEqual(["ACT-RES-2"]);
    expect(map["ACT-RES-2"].status).toBe("Submitted");
  });

  it("builds a chip regardless of stage/in-flight terminality (a linked card in ANY stage shows it)", () => {
    // Completed is terminal, but a linked transfer still gets a (green) chip —
    // the transfer-centric board no longer filters by an in-flight bucket.
    const map = buildAcatChipMap([
      listRow({ acatTransferId: "A1", status: "Completed" }),
    ]);
    expect(map.A1.tone).toBe("accepted");
    expect(map.A1.needsAttention).toBe(false);
  });

  it("returns an empty map for an empty/degraded list (board renders with no chips)", () => {
    expect(buildAcatChipMap([])).toEqual({});
  });

  it("first row wins when two list rows share an id (defensive)", () => {
    const map = buildAcatChipMap([
      listRow({ acatTransferId: "A1", status: "Accepted" }),
      listRow({ acatTransferId: "A1", status: "Rejected" }),
    ]);
    expect(map.A1.status).toBe("Accepted");
    expect(Object.keys(map)).toEqual(["A1"]);
  });
});

describe("filterAcatChipMapForVisibleRows (server → browser boundary)", () => {
  const accepted = {
    status: "Accepted",
    tone: "accepted" as const,
    needsAttention: false,
  };
  const submitted = {
    status: "Submitted",
    tone: "submitted" as const,
    needsAttention: false,
  };

  it("keeps only keys already present on RLS-visible transfer rows", () => {
    const filtered = filterAcatChipMapForVisibleRows(
      {
        "visible-record": accepted,
        "visible-uuid": submitted,
        "firmwide-record": accepted,
        "firmwide-uuid": submitted,
      },
      [
        {
          acat_record_id: "visible-record",
          acat_transfer_id: "visible-uuid",
        },
      ],
    );

    expect(filtered).toEqual({
      "visible-record": accepted,
      "visible-uuid": submitted,
    });
    expect(Object.keys(filtered)).not.toContain("firmwide-record");
    expect(Object.keys(filtered)).not.toContain("firmwide-uuid");
  });

  it("does not reveal the alternate tracker identity when the visible row stores only one", () => {
    const sharedChip = accepted;
    const filtered = filterAcatChipMapForVisibleRows(
      {
        "visible-record": sharedChip,
        "private-alternate-uuid": sharedChip,
      },
      [{ acat_record_id: "visible-record", acat_transfer_id: null }],
    );

    expect(filtered).toEqual({ "visible-record": sharedChip });
    expect(filtered["private-alternate-uuid"]).toBeUndefined();
  });

  it("returns no browser-visible identifiers for rows without ACAT links", () => {
    expect(
      filterAcatChipMapForVisibleRows(
        { "firmwide-record": accepted },
        [{ acat_record_id: null, acat_transfer_id: null }],
      ),
    ).toEqual({});
  });

  it("ignores IDs that are present on a row but absent from the tracker map", () => {
    expect(
      filterAcatChipMapForVisibleRows(
        { "other-record": accepted },
        [{ acat_record_id: "stale-record", acat_transfer_id: null }],
      ),
    ).toEqual({});
  });
});

describe("isLinkableAcatTransferId (denylist — drawer link + chip gating)", () => {
  it("accepts any non-empty, non-placeholder value regardless of length/shape", () => {
    expect(isLinkableAcatTransferId("1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isLinkableAcatTransferId("clh3k2j9x0000abcd1234efgh")).toBe(true);
    // A REAL but SHORT id must be accepted (the length-floor regression fix) —
    // this is the residual-row case ("ACT-RES-2", "ACT-NEIL-8", "A1").
    expect(isLinkableAcatTransferId("ACT-RES-2")).toBe(true);
    expect(isLinkableAcatTransferId("ACT-NEIL-8")).toBe(true);
    expect(isLinkableAcatTransferId("A1")).toBe(true);
    // Trims surrounding whitespace before testing.
    expect(isLinkableAcatTransferId("  ACT-RES-2  ")).toBe(true);
  });

  it("rejects empty/whitespace/null/undefined", () => {
    expect(isLinkableAcatTransferId("")).toBe(false);
    expect(isLinkableAcatTransferId("   ")).toBe(false);
    expect(isLinkableAcatTransferId(null)).toBe(false);
    expect(isLinkableAcatTransferId(undefined)).toBe(false);
  });

  it("rejects known placeholders case-insensitively (n/a, na, none, -, to come, tbd, pending, manual)", () => {
    for (const p of ["N/A", "n/a", "NA", "None", "-", "To Come", "TBD", "Pending", "Manual"]) {
      expect(isLinkableAcatTransferId(p)).toBe(false);
      // Case-insensitive + trimmed.
      expect(isLinkableAcatTransferId(`  ${p.toUpperCase()}  `)).toBe(false);
    }
  });
});

// --- detail-page ACAT section outcome (either-id fix) ------------------------

describe("acatSectionOutcome (the 404-with-a-link visible note)", () => {
  it("renders the card whenever the tracker returned a status", () => {
    expect(acatSectionOutcome(true, "rec-1", null)).toBe("card");
    expect(acatSectionOutcome(true, null, "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("card");
    // Defensive: a status with no ids still renders (the fetch was keyed
    // somehow) — never a blank.
    expect(acatSectionOutcome(true, null, null)).toBe("card");
  });

  it("a 404 while EITHER link id is stored → the visible missing-link note (never a silent blank)", () => {
    // The old behavior rendered NOTHING here — a mistyped/stale stored id made
    // the linked ACAT "just disappear" on the detail page.
    expect(acatSectionOutcome(false, "rec-gone", null)).toBe("missing_link");
    expect(
      acatSectionOutcome(false, null, "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"),
    ).toBe("missing_link");
    expect(acatSectionOutcome(false, "rec-gone", "also-set")).toBe("missing_link");
  });

  it("null-render survives ONLY for the defensive both-ids-null arm", () => {
    expect(acatSectionOutcome(false, null, null)).toBe("none");
  });
});
