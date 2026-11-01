/**
 * The duplicate scorer, as a pure function.
 *
 * This is the rule that decides what an operator is shown about two different clients' tickets, so it
 * is tested without a database and stated in cases a person can read: what counts as the same request,
 * what does not, and — the expensive direction — what must NOT be offered as a duplicate.
 */
import { describe, expect, it } from "vitest";
import type { DuplicateCandidateDTO } from "@/types/domain";
import {
  DUPLICATE_MAX_CANDIDATES,
  DUPLICATE_MIN_SCORE,
  DUPLICATE_WINDOW_MS,
  normalizeExternalRef,
  normalizePhone,
  normalizeSubject,
  rankCandidates,
  scoreDuplicateCandidate,
  subjectSimilarity,
  subjectTokens,
} from "@/server/duplicates";

const BASE_AT = new Date("2026-09-20T14:00:00.000Z");

function subject(over: Partial<Parameters<typeof scoreDuplicateCandidate>[0]> = {}) {
  return {
    requesterEmail: "dana@example.com",
    requesterPhone: null,
    subject: "Wire not received",
    externalRef: null,
    createdAt: BASE_AT,
    ...over,
  };
}

describe("normalizeSubject", () => {
  it("strips envelope prefixes, stacked and mixed", () => {
    expect(normalizeSubject("Re: Fwd: RE: Wire not received")).toBe("wire not received");
    expect(normalizeSubject("[EXTERNAL] Wire not received")).toBe("wire not received");
    expect(normalizeSubject("HD-1042 Wire not received")).toBe("wire not received");
  });

  it("drops punctuation, case and one-character tokens", () => {
    expect(normalizeSubject("WIRE — not received!!")).toBe("wire not received");
    expect(normalizeSubject("a b cc")).toBe("cc");
  });

  it("KEEPS negations: an aggressive stop list would make opposites look alike", () => {
    // "wire received" and "wire not received" are different requests, and the expensive mistake is
    // offering the second as a duplicate of the first.
    expect(subjectSimilarity("Wire received", "Wire not received")).toBeLessThan(1);
  });

  it("keeps the words that carry the request", () => {
    expect(subjectTokens("Please update the beneficiary on my IRA")).toEqual(["update", "beneficiary", "ira"]);
  });
});

describe("subjectSimilarity", () => {
  it("is order-independent, because subject lines are reordered constantly", () => {
    expect(subjectSimilarity("wire not received", "not received — wire")).toBe(1);
  });

  it("separates two different requests from the same person", () => {
    expect(subjectSimilarity("Wire not received", "Address change request")).toBe(0);
  });

  it("scores an empty subject as no evidence, never as agreement", () => {
    expect(subjectSimilarity("", "")).toBe(0);
    expect(subjectSimilarity("wire", "")).toBe(0);
  });
});

describe("normalizePhone / normalizeExternalRef", () => {
  it("treats every written form of one number as one number", () => {
    expect(normalizePhone("+1 (212) 555-0100")).toBe("12125550100");
    expect(normalizePhone("12125550100")).toBe("12125550100");
    expect(normalizePhone(null)).toBe("");
  });

  it("folds case and spacing on an external reference", () => {
    expect(normalizeExternalRef(" req-1042 ")).toBe("REQ-1042");
    expect(normalizeExternalRef("REQ 1042")).toBe("REQ1042");
  });
});

describe("scoreDuplicateCandidate", () => {
  it("ranks a shared external reference highest, with no time window", () => {
    const scored = scoreDuplicateCandidate(
      subject({ externalRef: "REQ-1042" }),
      subject({ externalRef: "req-1042", createdAt: new Date("2026-01-01T00:00:00.000Z"), subject: "Anything at all" }),
    );
    expect(scored).toEqual({ score: 0.98, reason: "same-external-ref" });
  });

  it("ranks same requester + similar subject as the ordinary duplicate", () => {
    const scored = scoreDuplicateCandidate(
      subject(),
      subject({ createdAt: new Date(BASE_AT.getTime() - 60 * 60_000), subject: "Re: wire not received" }),
    );
    expect(scored?.reason).toBe("same-requester-subject");
    expect(scored?.score).toBeGreaterThan(0.6);
  });

  it("ranks same requester + different subject as weak, but shows it", () => {
    const scored = scoreDuplicateCandidate(
      subject(),
      subject({ createdAt: new Date(BASE_AT.getTime() - 60 * 60_000), subject: "Address change" }),
    );
    expect(scored?.reason).toBe("same-requester-recent");
    expect(scored?.score).toBeLessThan(0.6);
    expect(scored?.score).toBeGreaterThanOrEqual(DUPLICATE_MIN_SCORE);
  });

  it("matches on the phone when the ticket has no email (Decision #62)", () => {
    const scored = scoreDuplicateCandidate(
      subject({ requesterEmail: null, requesterPhone: "+1 212 555 0100" }),
      subject({ requesterEmail: null, requesterPhone: "12125550100", subject: "Wire not received" }),
    );
    expect(scored?.reason).toBe("same-requester-subject");
  });

  it("NEVER offers a different requester, however identical the subject", () => {
    expect(
      scoreDuplicateCandidate(subject(), subject({ requesterEmail: "other@example.com" })),
    ).toBeNull();
  });

  it("NEVER offers a ticket outside the window", () => {
    expect(
      scoreDuplicateCandidate(
        subject(),
        subject({ createdAt: new Date(BASE_AT.getTime() - DUPLICATE_WINDOW_MS - 1) }),
      ),
    ).toBeNull();
  });

  it("does not match on a short or empty phone fragment", () => {
    expect(
      scoreDuplicateCandidate(
        subject({ requesterEmail: null, requesterPhone: "5550" }),
        subject({ requesterEmail: null, requesterPhone: "5550" }),
      ),
    ).toBeNull();
  });

  it("prefers the more recent of two equally similar tickets", () => {
    const recent = scoreDuplicateCandidate(subject(), subject({ createdAt: new Date(BASE_AT.getTime() - 60_000) }));
    const older = scoreDuplicateCandidate(
      subject(),
      subject({ createdAt: new Date(BASE_AT.getTime() - 6 * 24 * 60 * 60_000) }),
    );
    expect(recent?.score ?? 0).toBeGreaterThan(older?.score ?? 0);
  });
});

describe("rankCandidates", () => {
  function candidate(over: Partial<DuplicateCandidateDTO>): DuplicateCandidateDTO {
    return {
      ticketId: "t1",
      ticketNumber: 1,
      subject: "s",
      status: "OPEN",
      createdAt: BASE_AT.toISOString(),
      score: 0.5,
      reason: "same-requester-recent",
      ...over,
    };
  }

  it("drops anything under the floor", () => {
    expect(rankCandidates([candidate({ score: DUPLICATE_MIN_SCORE - 0.01 })])).toEqual([]);
  });

  it("orders by score, then recency, then number", () => {
    const ranked = rankCandidates([
      candidate({ ticketId: "a", ticketNumber: 1, score: 0.5 }),
      candidate({ ticketId: "b", ticketNumber: 2, score: 0.9 }),
      candidate({ ticketId: "c", ticketNumber: 3, score: 0.5, createdAt: "2026-09-21T00:00:00.000Z" }),
    ]);
    expect(ranked.map((c) => c.ticketId)).toEqual(["b", "c", "a"]);
  });

  it("caps the list, because a list nobody reads is a control nobody applies", () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate({ ticketId: `t${i}`, ticketNumber: i + 1, score: 0.9 }));
    expect(rankCandidates(many)).toHaveLength(DUPLICATE_MAX_CANDIDATES);
  });
});
