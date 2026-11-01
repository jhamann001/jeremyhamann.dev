/**
 * Source guard for `/admin/intake`'s pager, in the shape `admin-surface-probe.test.ts` uses (the repo
 * has no DOM test environment, so the client code is asserted as source).
 *
 * The defect this stands for was measured, not stylistic. `listHeldIntake` took 100 rows and stopped,
 * the page passed no limit, and the footer printed `${rows.length} messages shown.` — which reads as a
 * complete count. With 312 held messages the banner said "312 messages are waiting" and the list said
 * "100 messages shown", and the 212 that were missing were the OLDEST, because the order is
 * `createdAt desc`. Nothing in `SuspendedIntake` is ever deleted (the append-only triggers see to it),
 * so the "All" view crosses 100 permanently within weeks of the first mailbox move. On the one surface
 * whose justification is that a wire instruction failing DMARC must not sit unseen, a row that cannot
 * be reached is a row nobody sees.
 *
 * The transactional half — that the cursor walks the whole set without skipping or repeating a row —
 * is proven live in `src/server/suspended-intake.integration.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const VIEW = read("src/components/admin/intake/held-intake-view.tsx");
const PAGE = read("src/app/(app)/admin/intake/page.tsx");
const READS = read("src/server/suspended-intake.ts");

describe("the held-mail list can be paged past its first page", () => {
  it("the server returns a next cursor and the matched total, not a bare array", () => {
    expect(READS).toContain("export type HeldIntakePage");
    expect(READS).toContain("nextCursor");
    expect(READS).toContain("export async function listHeldIntakePage");
    // `take: take + 1` is how the next page is detected without a second count query.
    expect(READS).toContain("take: take + 1");
  });

  it("the read pages on a keyset, so a message held mid-walk cannot skip or repeat a row", () => {
    expect(READS).toContain("encodeHeldIntakeCursor");
    expect(READS).toContain("decodeHeldIntakeCursor");
    // createdAt is not unique; the id is the tie-break, and BOTH are in the order and the predicate.
    expect(READS).toContain('orderBy: [{ createdAt: "desc" }, { id: "desc" }]');
    expect(READS).toContain("{ createdAt: after.createdAt, id: { lt: after.id } }");
    expect(READS).not.toContain("skip:");
  });

  it("`total` honours the reason filter, which `heldIntakeCounts.total` does not", () => {
    const fn = /export async function listHeldIntakePage[\s\S]*?\n}\n/.exec(READS)?.[0] ?? "";
    expect(fn, "listHeldIntakePage was restructured").not.toBe("");
    expect(fn).toContain("prisma.suspendedIntake.count({ where })");
    // The count is built from the same `where` as the rows, BEFORE the keyset is applied — so it is
    // the whole filter, and it does not shrink as the reviewer pages.
    expect(fn.indexOf("const where = heldIntakeWhere(query)")).toBeLessThan(fn.indexOf("count({ where })"));
  });

  it("the page reads the cursor from the URL and drops one it did not write", () => {
    expect(PAGE).toContain("isHeldIntakeCursor(params.cursor)");
    expect(PAGE).toContain("listHeldIntakePage(viewer, { status, reason, mailbox: mailbox || undefined, cursor }, ctx)");
    expect(PAGE).toContain("cursor={cursor}");
  });

  it("the view offers Load more and keeps one URL writer for it", () => {
    expect(VIEW).toContain("data-intake-load-more");
    expect(VIEW).toContain("function loadMore()");
    expect(VIEW).toContain("page.nextCursor");
    // R3: the whole row is the target on a phone; R7: the same control and the same writer at every width.
    expect(VIEW).toContain('className="w-full sm:w-auto"');
    const loadMore = /function loadMore\(\)[\s\S]*?\n  }\n/.exec(VIEW)?.[0] ?? "";
    expect(loadMore).toContain("hrefFor(");
    expect(VIEW).not.toContain("fetch(");
  });

  it("a filter change starts again from the newest message", () => {
    // Literal patterns, one per function: `new RegExp(`${fn}…`)` is a security scanner CWE-185 finding (a pattern
    // built from a non-literal), and there are only ever the two filter writers to check.
    for (const [fn, re] of [
      ["function setStatus", /function setStatus\([\s\S]*?\n  }\n/],
      ["function setReason", /function setReason\([\s\S]*?\n  }\n/],
    ] as const) {
      const body = re.exec(VIEW)?.[0] ?? "";
      expect(body, `${fn} was restructured`).not.toBe("");
      expect(body).not.toContain("cursor");
    }
  });

  it("the count never reads as the whole list when it is not", () => {
    // The exact string that over-claimed. Its replacement always names the total beside the shown count.
    expect(VIEW).not.toContain("messages\"} shown.`");
    expect(VIEW).toContain("most recent of ${page.total.toLocaleString()} matching messages.");
    expect(VIEW).toContain("page.total.toLocaleString()");
    // A deep link INTO the middle of the list must not call its rows "the most recent" either.
    expect(VIEW).toContain("startedMidList");
    expect(VIEW).toContain("Start from the newest message");
  });

  it("no new tap-target opt-out was added to reach any of this", () => {
    expect(VIEW).not.toContain('data-tap="none"');
  });
});
