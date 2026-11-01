/**
 * `suspended-intake.ts` unit tests — no database.
 *
 * The capability predicates and the two filter guards are pure, and they are the part of this module
 * that decides who sees held client mail and who may turn it into a ticket. The transactional half —
 * what is written and what is audited — is proven live in `suspended-intake.integration.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { OktaGroup } from "@/types/domain";

const mockDb = vi.hoisted(() => ({
  prisma: {
    suspendedIntake: { findMany: vi.fn(), groupBy: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
  withTx: vi.fn(),
}));
vi.mock("@/lib/db", () => mockDb);

import {
  canReleaseHeldIntake,
  canReviewHeldIntake,
  decodeHeldIntakeCursor,
  encodeHeldIntakeCursor,
  HELD_INTAKE_DEFAULT_ROWS,
  HELD_INTAKE_MAX_ROWS,
  heldIntakeSenderVerified,
  isHeldIntakeCursor,
  isHeldIntakeReason,
  isHeldIntakeStatus,
} from "@/server/suspended-intake";
import { SUSPENDED_INTAKE_REASONS } from "@/types/domain";

const OPS: OktaGroup[] = ["ops_team"];
const CS: OktaGroup[] = ["client_services"];
const COMPLIANCE: OktaGroup[] = ["compliance_officers"];
const ADVISOR: OktaGroup[] = ["advisors"];

describe("canReviewHeldIntake", () => {
  it("admits ops_team and compliance_officers", () => {
    expect(canReviewHeldIntake(OPS)).toBe(true);
    expect(canReviewHeldIntake(COMPLIANCE)).toBe(true);
  });

  it("refuses advisors, client_services alone and a viewer with no groups", () => {
    expect(canReviewHeldIntake(ADVISOR)).toBe(false);
    expect(canReviewHeldIntake(CS)).toBe(false);
    expect(canReviewHeldIntake([])).toBe(false);
  });
});

describe("canReleaseHeldIntake", () => {
  it("needs BOTH review and WRITE on the destination queue", () => {
    expect(canReleaseHeldIntake(OPS, "OPERATIONS")).toBe(true);
    // ops_team only READS Client Service, so it cannot file a held message into that queue.
    expect(canReleaseHeldIntake(OPS, "CLIENT_SERVICE")).toBe(false);
    expect(canReleaseHeldIntake(["ops_team", "client_services"], "CLIENT_SERVICE")).toBe(true);
  });

  it("keeps compliance read-plus-annotate: it may review held mail and release none of it", () => {
    expect(canReviewHeldIntake(COMPLIANCE)).toBe(true);
    for (const q of ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"] as const) {
      expect(canReleaseHeldIntake(COMPLIANCE, q)).toBe(false);
    }
  });

  it("refuses a queue writer who is not a reviewer", () => {
    expect(canReleaseHeldIntake(CS, "CLIENT_SERVICE")).toBe(false);
    expect(canReleaseHeldIntake(ADVISOR, "ADVICE")).toBe(false);
  });
});

describe("filter guards", () => {
  it("accepts the three statuses and rejects anything else", () => {
    expect(isHeldIntakeStatus("NEW")).toBe(true);
    expect(isHeldIntakeStatus("RELEASED")).toBe(true);
    expect(isHeldIntakeStatus("DISCARDED")).toBe(true);
    expect(isHeldIntakeStatus("ALL")).toBe(false);
    expect(isHeldIntakeStatus("new")).toBe(false);
    expect(isHeldIntakeStatus("'; DROP TABLE")).toBe(false);
  });

  it("accepts the nine reasons and rejects anything else", () => {
    for (const r of [
      "UNAUTHENTICATED",
      "AUTO_REPLY",
      "BOUNCE",
      "SYSTEM_SENDER",
      "SPAM",
      "UNKNOWN_MAILBOX",
      "LOOP_DETECTED",
      "PARSE_FAILED",
      "OVERSIZE",
    ]) {
      expect(isHeldIntakeReason(r), r).toBe(true);
    }
    expect(isHeldIntakeReason("SENDER_MISMATCH")).toBe(false);
    expect(isHeldIntakeReason("")).toBe(false);
  });

  it("pins the page size bounds", () => {
    expect(HELD_INTAKE_DEFAULT_ROWS).toBe(100);
    expect(HELD_INTAKE_MAX_ROWS).toBe(500);
    expect(HELD_INTAKE_DEFAULT_ROWS).toBeLessThanOrEqual(HELD_INTAKE_MAX_ROWS);
  });
});

/**
 * The pager's keyset token. `/admin/intake` truncated at 100 rows with no pager and copy that read as
 * a complete count, so with 312 held messages the 212 OLDEST — the ones a reviewer is furthest behind
 * on — were unreachable at any width. This is the token that reaches the next page, and it arrives
 * from a URL, so what it refuses matters as much as what it round-trips.
 */
describe("held-mail keyset cursor", () => {
  const row = { createdAt: new Date("2026-09-19T14:03:07.412Z"), id: "cmf0s3k7x0001abcd1234wxyz" };

  it("round-trips the millisecond and the id", () => {
    const token = encodeHeldIntakeCursor(row);
    expect(token).toBe(`${row.createdAt.getTime()}.${row.id}`);
    const back = decodeHeldIntakeCursor(token);
    expect(back?.id).toBe(row.id);
    // TIMESTAMP(3): the millisecond survives the round trip exactly, so `lt` can neither skip a row
    // nor return one twice.
    expect(back?.createdAt.getTime()).toBe(row.createdAt.getTime());
    expect(back?.createdAt.toISOString()).toBe("2026-09-19T14:03:07.412Z");
  });

  it("carries the id, so two messages held in the SAME millisecond still page apart", () => {
    const a = encodeHeldIntakeCursor({ createdAt: row.createdAt, id: "aaa" });
    const b = encodeHeldIntakeCursor({ createdAt: row.createdAt, id: "bbb" });
    expect(a).not.toBe(b);
    expect(decodeHeldIntakeCursor(a)?.id).toBe("aaa");
    expect(decodeHeldIntakeCursor(b)?.id).toBe("bbb");
  });

  it("refuses anything it did not write, rather than throwing over a reviewer's queue", () => {
    for (const bad of [
      "",
      "abc",
      "1758290587412",
      ".cmf0s3k7x0001",
      "1758290587412.",
      "-1.cmf0s3k7x0001",
      "1758290587412.5.cmf0s3k7x0001",
      "1758290587412.'; DROP TABLE \"SuspendedIntake\"",
      "99999999999999999999.cmf0s3k7x0001",
      `1758290587412.${"x".repeat(65)}`,
    ]) {
      expect(decodeHeldIntakeCursor(bad), bad).toBeNull();
      expect(isHeldIntakeCursor(bad), bad).toBe(false);
    }
    expect(decodeHeldIntakeCursor(undefined)).toBeNull();
    expect(decodeHeldIntakeCursor(null)).toBeNull();
  });

  it("accepts its own output", () => {
    expect(isHeldIntakeCursor(encodeHeldIntakeCursor(row))).toBe(true);
    expect(isHeldIntakeCursor(encodeHeldIntakeCursor({ createdAt: new Date(0), id: "a" }))).toBe(true);
  });
});

/**
 * The rule that closed the hold-reason precedence gap: `ingestInboundEmail`'s gates are ordered and
 * `SuspendedIntakeReason` holds ONE value, so a message that failed sender authentication AND
 * arrived on an unmapped address is held as `UNKNOWN_MAILBOX` and its reason says nothing about its
 * sender. The review card and the release gate both read this function, so they cannot disagree.
 */
describe("heldIntakeSenderVerified", () => {
  it("is false for every UNAUTHENTICATED row, whatever the ledger recorded", () => {
    // Covers both the DMARC failure and the SENDER_MISMATCH hold, whose sender DID authenticate but
    // is not the thread's client. Neither may be loosened by the recorded verdict.
    expect(heldIntakeSenderVerified("UNAUTHENTICATED", false)).toBe(false);
    expect(heldIntakeSenderVerified("UNAUTHENTICATED", true)).toBe(false);
    expect(heldIntakeSenderVerified("UNAUTHENTICATED", null)).toBe(false);
  });

  it("is false on ANY other reason once the ledger recorded an authentication failure", () => {
    // The finding itself: an unauthenticated message to an unmapped mailbox used to read as benign.
    expect(heldIntakeSenderVerified("UNKNOWN_MAILBOX", false)).toBe(false);
    for (const reason of SUSPENDED_INTAKE_REASONS) {
      expect(heldIntakeSenderVerified(reason, false), reason).toBe(false);
    }
  });

  it("is true when the hold recorded a passing verdict and the reason is not UNAUTHENTICATED", () => {
    expect(heldIntakeSenderVerified("UNKNOWN_MAILBOX", true)).toBe(true);
    expect(heldIntakeSenderVerified("AUTO_REPLY", true)).toBe(true);
    expect(heldIntakeSenderVerified("SPAM", true)).toBe(true);
    expect(heldIntakeSenderVerified("PARSE_FAILED", true)).toBe(true);
  });

  it("falls back to the reason when no verdict was recorded, so pre-fix rows keep their meaning", () => {
    // `null` is UNKNOWN, not "verified": nothing is retroactively claimed about a message nobody
    // measured, and nothing that used to be shown as cautioned stops being cautioned.
    for (const reason of SUSPENDED_INTAKE_REASONS) {
      expect(heldIntakeSenderVerified(reason, null), reason).toBe(reason !== "UNAUTHENTICATED");
    }
  });
});
