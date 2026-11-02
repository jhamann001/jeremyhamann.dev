import { describe, it, expect } from "vitest";
import {
  ACAT_STATUS_CATALOG,
  CANONICAL_ACAT_STATUS_KEYS,
  UNKNOWN_STATUS_LABEL,
  humanizeStatus,
  resolveAcatStatus,
  type AcatPhase,
} from "@/lib/data/acat-status-catalog";

// ticket — canonical ACAT status catalog. The tracker returns RAW PascalCase
// enum values; this catalog is the single source that maps each to a friendly
// label + lifecycle order + phase + tone, with a safe fallback for anything
// unmapped.

// The owner-provided 16 canonical statuses, in lifecycle order, keyed on the
// EXACT raw tracker enum value.
const CANONICAL: {
  raw: string;
  label: string;
  order: number;
  phase: AcatPhase;
}[] = [
  { raw: "WaitingForApex", label: "Waiting for Apex", order: 1, phase: "in_flight" },
  { raw: "PendingAccountOpening", label: "Pending Account Opening", order: 2, phase: "in_flight" },
  { raw: "WaitingOnClient", label: "Waiting on Client", order: 3, phase: "in_flight" },
  { raw: "AcatReceived", label: "ACAT Received", order: 4, phase: "in_flight" },
  { raw: "ToCome", label: "To Come", order: 5, phase: "in_flight" },
  { raw: "Submitted", label: "Submitted", order: 6, phase: "in_flight" },
  { raw: "PendingReview", label: "Pending Review", order: 7, phase: "in_flight" },
  { raw: "PendingContraResponse", label: "Pending Contra Response", order: 8, phase: "in_flight" },
  { raw: "Accepted", label: "Accepted", order: 9, phase: "in_flight" },
  { raw: "PendingSettlement", label: "Pending Settlement", order: 10, phase: "in_flight" },
  { raw: "PendingBookkeeping", label: "Pending Bookkeeping", order: 11, phase: "in_flight" },
  { raw: "Completed", label: "Completed", order: 12, phase: "completed" },
  { raw: "Rejected", label: "Rejected", order: 13, phase: "attention" },
  { raw: "Purged", label: "Purged", order: 14, phase: "attention" },
  { raw: "Canceled", label: "Canceled", order: 15, phase: "attention" },
  { raw: "Deferred", label: "Deferred", order: 16, phase: "attention" },
];

describe("ACAT status catalog — the 16 canonical statuses", () => {
  it.each(CANONICAL)(
    "$raw → label '$label', order $order, phase $phase",
    ({ raw, label, order, phase }) => {
      const meta = resolveAcatStatus(raw);
      expect(meta.known).toBe(true);
      expect(meta.label).toBe(label);
      expect(meta.order).toBe(order);
      expect(meta.phase).toBe(phase);
      expect(meta.raw).toBe(raw);
    },
  );

  it("assigns a strictly increasing lifecycle order across the canonical set", () => {
    const orders = CANONICAL.map((c) => resolveAcatStatus(c.raw).order);
    const sorted = [...orders].sort((a, b) => a - b);
    expect(orders).toEqual(sorted);
    expect(new Set(orders).size).toBe(orders.length); // no duplicate indices
  });

  it("gives the 'Pending Settlement' status its own friendly label (the reported bug)", () => {
    const meta = resolveAcatStatus("PendingSettlement");
    expect(meta.label).toBe("Pending Settlement");
    expect(meta.phase).toBe("in_flight");
    expect(meta.order).toBe(10);
  });
});

describe("ACAT status catalog — tones", () => {
  it("assigns rejected tone to the error/cancel terminals", () => {
    expect(resolveAcatStatus("Rejected").tone).toBe("rejected");
    expect(resolveAcatStatus("Canceled").tone).toBe("rejected");
  });
  it("assigns green (accepted) to progress/success statuses", () => {
    expect(resolveAcatStatus("Accepted").tone).toBe("accepted");
    expect(resolveAcatStatus("AcatReceived").tone).toBe("accepted");
    expect(resolveAcatStatus("Completed").tone).toBe("accepted");
  });
  it("assigns amber (submitted) to the pending/submitted statuses", () => {
    expect(resolveAcatStatus("Submitted").tone).toBe("submitted");
    expect(resolveAcatStatus("PendingSettlement").tone).toBe("submitted");
    expect(resolveAcatStatus("PendingReview").tone).toBe("submitted");
  });
  it("assigns neutral to the passive-wait statuses", () => {
    expect(resolveAcatStatus("WaitingForApex").tone).toBe("neutral");
    expect(resolveAcatStatus("WaitingOnClient").tone).toBe("neutral");
    expect(resolveAcatStatus("ToCome").tone).toBe("neutral");
  });
});

describe("ACAT status catalog — legacy recon-derived values (exhaustive vs the tracker enum)", () => {
  it("maps the recon-derived trio to the tracker's 'Recon: …' labels", () => {
    expect(resolveAcatStatus("Matched").label).toBe("Recon: Matched");
    expect(resolveAcatStatus("Mismatch").label).toBe("Recon: Mismatch");
    expect(resolveAcatStatus("Pending").label).toBe("Recon: Pending");
    for (const s of ["Matched", "Mismatch", "Pending"]) {
      expect(resolveAcatStatus(s).known).toBe(true);
    }
  });

  it("covers every raw value the tracker's AcatStatus enum can emit", () => {
    // Mirror of the tracker enum (prisma AcatStatus). If the tracker adds a
    // value, this list — and the catalog — must be updated in lock-step.
    const trackerEnum = [
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
      "Completed",
      "Rejected",
      "Purged",
      "Canceled",
      "Deferred",
      "Matched",
      "Mismatch",
      "Pending",
    ];
    for (const v of trackerEnum) {
      expect(ACAT_STATUS_CATALOG[v], `catalog missing ${v}`).toBeDefined();
    }
    expect(CANONICAL_ACAT_STATUS_KEYS).toEqual(trackerEnum);
  });
});

describe("ACAT status catalog — safe fallback for unmapped / blank values", () => {
  it("routes null/blank to the visible 'Unknown status' bucket (neutral, attention)", () => {
    for (const v of [null, undefined, "", "   "]) {
      const meta = resolveAcatStatus(v);
      expect(meta.known).toBe(false);
      expect(meta.label).toBe(UNKNOWN_STATUS_LABEL);
      expect(meta.tone).toBe("neutral");
      expect(meta.phase).toBe("attention");
    }
  });

  it("humanizes an unmapped raw value so it stays readable and visible", () => {
    const meta = resolveAcatStatus("SomeBrandNewStatus");
    expect(meta.known).toBe(false);
    expect(meta.label).toBe("Some Brand New Status");
    expect(meta.tone).toBe("neutral");
    expect(meta.phase).toBe("attention");
  });

  it("sorts unknowns AFTER every known status (high order index) but never drops them", () => {
    const knownMax = Math.max(
      ...CANONICAL_ACAT_STATUS_KEYS.map((k) => resolveAcatStatus(k).order),
    );
    expect(resolveAcatStatus("SomethingWeird").order).toBeGreaterThan(knownMax);
    expect(resolveAcatStatus(null).order).toBeGreaterThan(knownMax);
  });
});

describe("humanizeStatus", () => {
  it("splits PascalCase into spaced Title Case", () => {
    expect(humanizeStatus("PendingSettlement")).toBe("Pending Settlement");
    expect(humanizeStatus("ToCome")).toBe("To Come");
  });
  it("normalizes snake_case and kebab-case", () => {
    expect(humanizeStatus("pending_settlement")).toBe("Pending Settlement");
    expect(humanizeStatus("pending-review")).toBe("Pending Review");
  });
  it("never returns an empty string for a non-empty input", () => {
    expect(humanizeStatus("x")).toBe("X");
  });
});
