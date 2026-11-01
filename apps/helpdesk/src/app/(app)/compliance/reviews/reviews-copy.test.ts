/**
 * Fix round 2 — a source guard on the review queue's vocabulary.
 *
 * The Wave A copy rule (CROSSWALK P16) reserves the word "Sent" for
 * `DeliveryChip` / `MESSAGE_DELIVERY_STATUS_LABELS`, which print it only when a sender reported a
 * result. `reviews-view.tsx` printed it as plain product copy four times — two date-filter labels
 * ("Sent from" / "Sent to", separately ambiguous on a correspondence screen, where they read as
 * sender and recipient), the row byline ("Sent by …") and the stamp sheet heading ("· sent …") —
 * so a reviewer could read "Sent by Olivia Ops · delivery: Not sent (suppressed)" in one sentence,
 * and a phone-only requester (`deliveryStatus === null`) got a bare "Sent by" with no
 * delivery clause at all to correct it.
 *
 * The repo has no DOM test environment, so this asserts the SHAPE of the client source the way
 * `src/components/ticket/composer-copy.test.ts` does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const view = readFileSync(path.join(ROOT, "src/app/(app)/compliance/reviews/reviews-view.tsx"), "utf8");

/** Comments explain the rule by quoting the old copy; only rendered strings are under test. */
const rendered = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the review queue never states transmission in its own words", () => {
  it("prints no form of 'sent' outside the shared delivery label map", () => {
    for (const forbidden of ["Sent from", "Sent to", "Sent by", "· sent ", "was sent", "has been sent"]) {
      expect(rendered, `review queue copy still says "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("labels the date filters as a date range, not as sender and recipient", () => {
    expect(rendered).toContain("Replied on or after");
    expect(rendered).toContain("Replied on or before");
  });

  it("attributes the reply to its author without claiming it left the desk", () => {
    expect(rendered).toContain("Written by {row.author?.name ?? row.authorLabel}");
  });

  it("dates the stamp sheet by when the reply was saved", () => {
    expect(rendered).toContain("· saved ${formatDateTime(stampFor.sentAt)}");
  });
});

describe("the delivery clause is the only statement about transmission, and it always prints", () => {
  it("routes a known status through the shared label map", () => {
    expect(rendered).toContain("MESSAGE_DELIVERY_STATUS_LABELS[row.deliveryStatus]");
    // Never the raw enum: `FAILED_SUPPRESSED` and `LEASED` mislead a compliance officer.
    expect(rendered).not.toContain("{row.deliveryStatus}");
  });

  it("says so explicitly when nothing was ever queued, instead of falling silent", () => {
    expect(rendered).toContain("none queued");
    expect(rendered).not.toMatch(/row\.deliveryStatus !== null[\s\S]{0,200}?:\s*""/);
  });
});
