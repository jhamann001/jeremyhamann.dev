/**
 * `/no-access` records the attempted PATH and never its query string.
 *
 * The finding this pins is the build record (B12's integration note §3.2): the page
 * writes what it receives into `AuditLog.newValue`, which is append-only and no-hard-delete, and a
 * forbidden URL can carry `?requesterEmail=<a client's address>`. `sanitizePII` does not redact an
 * address — that is deliberate, an address is a first-class ticket field — so such a row could never
 * be corrected afterwards. `src/auth.config.ts` drops the query before redirecting (asserted in
 * `src/auth.config.test.ts`); this is the second of the two, because a `/no-access?from=…` link can
 * be typed, pasted or bookmarked and reach the page without going through that redirect.
 *
 * A source-level assertion rather than a render: the page is an async server component that reads a
 * session, a request context and the ledger, and standing all three up would test the mocks. The
 * behaviour under test is one expression, and pinning it is what stops it being "simplified" back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/app/no-access/page.tsx"), "utf8");

describe("/no-access records the path only (I14)", () => {
  it("strips anything after `?` before the value reaches the ledger", () => {
    expect(SRC).toContain('const path = attempted.split("?", 1)[0];');
    // The stripped value is what is recorded — not `attempted`, and not `from`.
    expect(SRC).toContain("`path:${path}`");
    expect(SRC).not.toContain("`path:${attempted}`");
    expect(SRC).not.toContain("`path:${from}`");
  });

  it("still validates the shape first — the strip is on top of `safeRelativePath`, not instead of it", () => {
    expect(SRC).toContain('safeRelativePath(from, "invalid")');
    // The order matters: validate, then strip. Reversing them would hand `safeRelativePath` a value
    // the caller had already rewritten.
    expect(SRC.indexOf("safeRelativePath(from")).toBeLessThan(SRC.indexOf('attempted.split("?"'));
  });

  it("never echoes `from` back into the rendered page", () => {
    // The page states that the attempt was recorded; it does not repeat the URL at the reader.
    // Scoped to the JSX — `const { from } = await searchParams` above it is the read, not an echo.
    const jsx = SRC.slice(SRC.indexOf("return ("));
    expect(jsx.length, "the component's return was restructured").toBeGreaterThan(0);
    // One LITERAL pattern per name rather than `new RegExp(`\\{\\s*${name}\\b`)` over a loop: a
    // pattern assembled from a loop variable is a security scanner CWE-185 finding,
    // and the build record is explicit that a test builds no pattern at run time. Unrolled
    // rather than shortened — the four names ARE the assertion, so they are written out.
    expect(jsx, "the rendered page must not echo from").not.toMatch(/\{\s*from\b/);
    expect(jsx, "the rendered page must not echo path").not.toMatch(/\{\s*path\b/);
    expect(jsx, "the rendered page must not echo attempted").not.toMatch(/\{\s*attempted\b/);
    expect(jsx, "the rendered page must not echo searchParams").not.toMatch(/\{\s*searchParams\b/);
  });

  it("the sentinels contain no `?`, so they pass through the strip unchanged", () => {
    for (const sentinel of ["unknown", "invalid"]) {
      expect(sentinel.split("?", 1)[0]).toBe(sentinel);
      expect(SRC).toContain(`"${sentinel}"`);
    }
  });

  it("the strip does what it says, on the shapes that matter", () => {
    const strip = (v: string): string => v.split("?", 1)[0];
    expect(strip("/queues/advice?requesterEmail=someone@example.com")).toBe("/queues/advice");
    expect(strip("/queues/advice?a=1?b=2")).toBe("/queues/advice");
    expect(strip("/queues/advice")).toBe("/queues/advice");
    expect(strip("invalid")).toBe("invalid");
    expect(strip("unknown")).toBe("unknown");
    // A bare `?` leaves the path, not an empty string with a dangling marker.
    expect(strip("/queues/advice?")).toBe("/queues/advice");
  });
});
