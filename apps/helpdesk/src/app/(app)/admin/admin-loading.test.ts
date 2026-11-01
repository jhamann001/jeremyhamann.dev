/**
 * Static source checks over the `/admin` segment's loading boundary
 * (docs/MOBILE_FIRST.md §7 probe G13).
 *
 * The finding this covers: Wave A added three `/admin/*` routes, every one of them a
 * `force-dynamic` server render that authenticates, authorizes and then queries before its first
 * byte — and `find src/app -name loading.tsx` returned exactly one file, the ticket segment's. G13
 * is a GLOBAL probe and §7's Wave A admin bullet makes the global probes binding on these screens,
 * so all three failed it on the phone entry points this wave created.
 *
 * These are SOURCE assertions, in the style of `src/app/(app)/tickets/[id]/streaming.test.ts`,
 * because the repo has no DOM test environment: what must not regress is structural — a boundary
 * exists above every admin page, and the fallback neither reads nor leaks anything, which matters
 * more here than on the ticket page because `loading.tsx` renders before the RBAC gate has run.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SEGMENT = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.join(SEGMENT, "..", "..", "..", "..");

function read(file: string): string {
  return readFileSync(path.join(SEGMENT, file), "utf8");
}

/** The body of the file with comments stripped, so a pattern never matches prose in a doc block. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const LOADING = read("loading.tsx");
const LOADING_CODE = code(LOADING);

/** Every child segment of `/admin` that renders a page — the routes the boundary has to cover. */
const ADMIN_ROUTES = readdirSync(SEGMENT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe("admin segment — loading boundary (G13)", () => {
  it("covers every /admin route from one boundary at the segment root", () => {
    // A loading.tsx is the Suspense fallback for its own segment AND every segment nested under it,
    // so a route added later is covered without a second file. This asserts the boundary is at the
    // ROOT: if it ever moved down into one route, the others would silently lose it.
    expect(ADMIN_ROUTES).toEqual([
      "api-tokens",
      "flags",
      "intake",
      "macros",
      "sla",
      "suppression",
      "users",
      "webhooks",
    ]);
    for (const route of ADMIN_ROUTES) {
      const files = readdirSync(path.join(SEGMENT, route));
      expect(files).toContain("page.tsx");
      expect(files, `${route} must rely on the segment boundary, not shadow it`).not.toContain("loading.tsx");
    }
    expect(LOADING_CODE).toMatch(/export default function \w+\(\)/);
    expect(LOADING_CODE).toContain("Skeleton");
  });

  it("is needed: each admin page is a force-dynamic render that gates and queries before its first byte", () => {
    for (const route of ADMIN_ROUTES) {
      const page = code(readFileSync(path.join(SEGMENT, route, "page.tsx"), "utf8"));
      expect(page).toContain('export const dynamic = "force-dynamic"');
      expect(page).toContain("await requireUser()");
      expect(page).toMatch(/notFound\(\)/);
    }
  });

  it("renders no data in the fallback — it runs before the RBAC gate, not just before the read (I5)", () => {
    // No server module, no session, no db, no audit, no params: the fallback is painted for a viewer
    // we have not authorized yet, so it must not be able to describe a macro, an account or held mail.
    expect(LOADING_CODE).not.toMatch(/from "@\/server\//);
    expect(LOADING_CODE).not.toMatch(/from "@\/lib\/(session|db|audit|rbac)"/);
    expect(LOADING_CODE).not.toContain("searchParams");
    expect(LOADING_CODE).not.toContain("params");
    expect(LOADING_CODE).not.toContain("await ");
    expect(LOADING_CODE).not.toContain("async ");
  });

  it("announces the wait to a screen reader rather than only to the eye (R10)", () => {
    expect(LOADING_CODE).toMatch(/aria-busy="true"/);
    expect(LOADING_CODE).toMatch(/role="status"/);
  });

  it("does not repeat the heading band the admin layout already renders", () => {
    // `admin/layout.tsx` is pure markup and is on screen before the fallback; an <h1>/"Admin" here
    // would paint the title twice for the width of one navigation.
    expect(LOADING_CODE).not.toContain("<h1");
    expect(LOADING_CODE).not.toContain("Admin</");
  });

  it("gives the skeleton the phone tap sizes the real controls carry (R3, G2)", () => {
    // The search field and the filter chips are the two controls every admin view has; a fallback
    // that draws them shorter than 44 px makes the list jump the moment the real page lands.
    expect(LOADING_CODE).toMatch(/h-11 w-full md:h-9/);
    expect(LOADING_CODE).toMatch(/h-11 min-w-11/);
  });

  it("is recorded in the mobile QA checklist beside the probe it satisfies", () => {
    const mobileFirst = readFileSync(path.join(REPO_ROOT, "docs/MOBILE_FIRST.md"), "utf8");
    expect(mobileFirst).toContain("G13");
    expect(mobileFirst).toMatch(/src\/app\/\(app\)\/admin\/loading\.tsx/);
  });
});
