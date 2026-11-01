/**
 * The delivery chip's wording, and the copy rule it exists to protect (the build record S3,
 * binding; the build record P16): **only the chip may say "Sent", and only on a SENT delivery.**
 *
 * The chip component itself is JSX and is NOT imported here (same reason as `sla-badge-label.test.ts`);
 * everything it prints — label, tooltip/aria detail, failure line — comes from the pure helpers pinned
 * below, plus the audience badge constant that used to contradict them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CommentDeliveryDTO, MessageDeliveryStatus } from "@/types/domain";
import { MESSAGE_DELIVERY_STATUS_LABELS } from "@/types/domain";
import { formatDateTime } from "@/lib/format";
import {
  deliveryChipAriaLabel,
  deliveryChipStyle,
  deliveryDetail,
  deliveryFailureNote,
} from "@/components/tickets/delivery-chip-label";
import {
  INTERNAL_NOTE_LABEL,
  PUBLIC_REPLY_LABEL,
} from "@/components/tickets/internal-note-styles";

const ALL_STATUSES: MessageDeliveryStatus[] = ["QUEUED", "LEASED", "SENT", "FAILED"];

function delivery(overrides: Partial<CommentDeliveryDTO> = {}): CommentDeliveryDTO {
  return {
    id: "del_1",
    status: "QUEUED",
    attempts: 0,
    toAddress: "client@example.com",
    sentAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("deliveryChipStyle", () => {
  it("prints the shared label for every status and never a raw enum", () => {
    for (const status of ALL_STATUSES) {
      const style = deliveryChipStyle(status);
      expect(style.label).toBe(MESSAGE_DELIVERY_STATUS_LABELS[status]);
      expect(style.label).not.toBe(status);
    }
  });

  it("says 'Sent' on SENT and on nothing else", () => {
    expect(deliveryChipStyle("SENT").label).toBe("Sent");
    for (const status of ALL_STATUSES.filter((s) => s !== "SENT")) {
      expect(deliveryChipStyle(status).label.toLowerCase()).not.toContain("sent");
    }
  });

  it("marks a failure destructive and leaves the in-flight states quiet", () => {
    expect(deliveryChipStyle("FAILED").variant).toBe("destructive");
    expect(deliveryChipStyle("SENT").variant).toBe("secondary");
    expect(deliveryChipStyle("QUEUED").variant).toBe("outline");
    expect(deliveryChipStyle("LEASED").variant).toBe("outline");
  });

  it("gives each status its own icon", () => {
    const icons = ALL_STATUSES.map((s) => deliveryChipStyle(s).icon);
    expect(new Set(icons).size).toBe(ALL_STATUSES.length);
  });
});

describe("deliveryDetail", () => {
  it("always names the address it is going to", () => {
    for (const status of ALL_STATUSES) {
      expect(deliveryDetail(delivery({ status }))).toContain("To client@example.com");
    }
  });

  it("dates a SENT delivery from sentAt", () => {
    const sentAt = "2026-09-16T12:00:00.000Z";
    const detail = deliveryDetail(delivery({ status: "SENT", sentAt, attempts: 1 }));
    expect(detail).toContain(`Sent ${formatDateTime(sentAt)}`);
  });

  it("does not claim a send time a SENT row does not carry", () => {
    expect(deliveryDetail(delivery({ status: "SENT", sentAt: null }))).toBe("To client@example.com");
  });

  it("counts attempts and quotes the error on FAILED, pluralising correctly", () => {
    const one = deliveryDetail(delivery({ status: "FAILED", attempts: 1, lastError: "550 mailbox unavailable" }));
    expect(one).toContain("1 attempt");
    expect(one).not.toContain("1 attempts");
    expect(one).toContain("550 mailbox unavailable");
    expect(deliveryDetail(delivery({ status: "FAILED", attempts: 3 }))).toContain("3 attempts");
  });

  it("explains the two in-flight states in words, without saying it was sent", () => {
    expect(deliveryDetail(delivery({ status: "QUEUED" }))).toContain("Waiting for the sender to pick it up");
    expect(deliveryDetail(delivery({ status: "LEASED" }))).toContain("A sender is delivering it now");
    expect(deliveryDetail(delivery({ status: "QUEUED" })).toLowerCase()).not.toContain("sent ");
  });
});

describe("deliveryChipAriaLabel", () => {
  it("leads with the status, then the detail", () => {
    const d = delivery({ status: "FAILED", attempts: 2, lastError: "timeout" });
    expect(deliveryChipAriaLabel(d)).toBe(`Delivery: Failed. ${deliveryDetail(d)}`);
  });
});

describe("deliveryFailureNote", () => {
  it("renders only for a FAILED delivery that carries a reason", () => {
    expect(deliveryFailureNote(delivery({ status: "FAILED", attempts: 3, lastError: "timeout" }))).toBe(
      "Delivery failed after 3 attempts: timeout",
    );
    expect(deliveryFailureNote(delivery({ status: "FAILED", attempts: 3, lastError: null }))).toBeNull();
    expect(deliveryFailureNote(delivery({ status: "QUEUED" }))).toBeNull();
    expect(deliveryFailureNote(delivery({ status: "SENT", sentAt: "2026-09-16T12:00:00.000Z" }))).toBeNull();
  });

  it("pluralises the attempt count", () => {
    expect(deliveryFailureNote(delivery({ status: "FAILED", attempts: 1, lastError: "timeout" }))).toBe(
      "Delivery failed after 1 attempt: timeout",
    );
  });
});

describe("the audience badge beside the chip", () => {
  it("never claims delivery — the chip owns that word", () => {
    expect(PUBLIC_REPLY_LABEL).toBe("Client-visible reply");
    expect(PUBLIC_REPLY_LABEL.toLowerCase()).not.toContain("sent");
  });

  it("stays true for every delivery state a saved reply can be in", () => {
    // The badge is printed next to the chip on the timeline, on the preview card, and on the composer
    // pane before a character is typed. There must be no status it contradicts.
    for (const status of ALL_STATUSES) {
      expect(`${PUBLIC_REPLY_LABEL} · ${deliveryChipStyle(status).label}`).not.toContain("Sent to client");
    }
  });

  it("leaves the internal-note wording alone (it may say 'sent' — it is a promise never to)", () => {
    expect(INTERNAL_NOTE_LABEL).toBe("Internal note — never sent to client");
  });
});

/**
 * Fix round 1. The rule above was re-litigated per slice instead of being enforced, and Wave B shipped
 * a `Notification` preview reading "Public reply sent to the client" for a reply that is only QUEUED at
 * that point — and that may be CANCELLED by a retraction, FAILED_SUPPRESSED by the suppression list, or
 * never emailed at all on a phone-only ticket. A preview is a permanent row, so the
 * claim outlives the delivery it describes, and once `SLACK_USER_MAP` or the VAPID trio are set it is
 * the text a recipient reads off-platform.
 *
 * So the rule is mechanical now: no notification preview built anywhere in `src/server/**` may use the
 * word "sent". The chip is the only surface that may, and it is pinned above.
 */
describe("no notification preview claims delivery", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

  function tsFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) tsFiles(full, acc);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
    }
    return acc;
  }

  const files = tsFiles(path.join(ROOT, "src/server"));

  it("reads the server modules at all", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds no `preview:` literal containing the word 'sent'", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // `preview:` followed by a string or template literal on the same line — every producer in this
      // codebase writes it that way, and a computed preview would be caught by its own unit test.
      for (const m of src.matchAll(/preview:\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
        if (/\bsent\b/i.test(m[2])) offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(offenders, "notification previews claiming delivery").toEqual([]);
  });
});

/**
 * Fix round 1, the sibling rule: **the UI never prints a raw enum** (`delivery-chip-label.ts`).
 * `/compliance/reviews` printed `row.deliveryStatus.toLowerCase()`, so an auditor read "delivery
 * failed_suppressed", "delivery leased" and "delivery cancelled" — and two of those are actively
 * misleading (`LEASED` means Sending; `FAILED_SUPPRESSED` means the desk chose not to send, which is
 * the whole reason Wave B added the status). Lowercasing an enum is the shape of that mistake, so
 * that is what this scans for.
 */
describe("no surface lowercases an enum instead of labelling it", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
    }
    return acc;
  }

  // Scoped to the RENDERED surfaces. `src/server/ticket-export.ts` lowercases `authorKind` on purpose,
  // into a CSV cell where the value stands in for an author that does not exist by design.
  const UI_ROOTS = ["src/app", "src/components"];

  it("finds no `<something>Status.toLowerCase()` on a rendered surface", () => {
    const offenders: string[] = [];
    for (const file of UI_ROOTS.flatMap((r) => sourceFiles(path.join(ROOT, r)))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*(?:Status|Kind|Reason|Verdict|Priority)\b\.toLowerCase\(\)/g)) {
        offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(offenders, "raw enums being lowercased instead of read through a label map").toEqual([]);
  });
});
