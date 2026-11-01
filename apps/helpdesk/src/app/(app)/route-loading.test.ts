/**
 * Every `(app)` route segment has a loading boundary above its slowest child (docs/MOBILE_FIRST.md §7
 * probe G13), and no fallback can describe data it has not been authorized to read.
 *
 * Round 2 added `src/app/(app)/admin/loading.tsx` for the three admin routes and recorded that
 * `/dashboard`, `/queues` and `/compliance/audit` still had none. Those are the bottom navigation's
 * own destinations: with no boundary, a tab tap held the previous screen on display, unchanged, for a
 * `force-dynamic` render that authenticates, authorizes and then runs three parallel reads — the dead
 * tap G13 exists to catch, on the surfaces a phone user touches most.
 *
 * Source assertions, in the style of `src/app/(app)/admin/admin-loading.test.ts` and
 * `src/app/(app)/tickets/[id]/streaming.test.ts`: the repo has no DOM test environment, and what must
 * not regress here is structural.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.join(APP, "..", "..", "..");

/** Strip comments, so a pattern never matches prose in a doc block. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every directory under `(app)` that holds a `page.tsx`, relative to `(app)`. */
function pageDirs(dir: string, rel = "", acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const childRel = rel === "" ? entry : `${rel}/${entry}`;
    if (existsSync(path.join(full, "page.tsx"))) acc.push(childRel);
    pageDirs(full, childRel, acc);
  }
  return acc;
}

/** The nearest `loading.tsx` at or above `rel`, or null. A loading.tsx covers every nested segment. */
function boundaryFor(rel: string): string | null {
  const parts = rel.split("/");
  for (let i = parts.length; i >= 0; i--) {
    const candidate = path.join(APP, ...parts.slice(0, i), "loading.tsx");
    if (existsSync(candidate)) return path.relative(APP, candidate);
  }
  return null;
}

const PAGE_DIRS = pageDirs(APP);

describe("every (app) route paints something while it renders (G13)", () => {
  it("found the routes this app actually ships", () => {
    // Guards the scan itself: a rename that made `pageDirs` return nothing would make every
    // assertion below vacuous.
    expect(PAGE_DIRS.length).toBeGreaterThanOrEqual(7);
    for (const expected of [
      "dashboard",
      "queues/[queue]",
      "compliance/audit",
      "tickets/[id]",
      "tickets/new",
      "admin/macros",
      "admin/users",
      "admin/intake",
    ]) {
      expect(PAGE_DIRS, `${expected} is no longer a route — update this list`).toContain(expected);
    }
  });

  it("has a boundary at or above every one of them", () => {
    const missing = PAGE_DIRS.filter((rel) => boundaryFor(rel) === null);
    expect(missing, "route segments with no loading.tsx above them").toEqual([]);
  });

  it("every page it covers is a force-dynamic render that gates before its first byte", () => {
    // If a page stopped being dynamic its boundary would be dead weight; this keeps the two honest.
    for (const rel of PAGE_DIRS) {
      const page = code(readFileSync(path.join(APP, rel, "page.tsx"), "utf8"));
      expect(page, `${rel} is no longer force-dynamic`).toContain('export const dynamic = "force-dynamic"');
      expect(page, `${rel} no longer authenticates`).toMatch(/await require(User|Group)\(/);
    }
  });

  it("no fallback reads anything — it paints before the RBAC gate, not just before the read (I5)", () => {
    const loadings = [
      ...new Set(PAGE_DIRS.map(boundaryFor).filter((p): p is string => p !== null)),
      "../../components/shell/route-skeleton.tsx",
    ];
    for (const rel of loadings) {
      const text = code(readFileSync(path.join(APP, rel), "utf8"));
      expect(text, `${rel} imports a server module`).not.toMatch(/from "@\/server\//);
      expect(text, `${rel} imports session/db/audit/rbac`).not.toMatch(
        /from "@\/lib\/(session|db|audit|rbac|env)"/,
      );
      expect(text, `${rel} reads route input`).not.toMatch(/\bsearchParams\b|\bparams\b/);
      expect(text, `${rel} awaits`).not.toContain("await ");
      expect(text, `${rel} is async`).not.toContain("async ");
    }
  });

  it("announces the wait to a screen reader, not only to the eye (R10)", () => {
    const skeleton = readFileSync(path.join(APP, "../../components/shell/route-skeleton.tsx"), "utf8");
    expect(skeleton).toMatch(/aria-busy="true"/);
    expect(skeleton).toMatch(/role="status"/);
    // One announcement per fallback, so a screen reader is not told three times that it is loading.
    expect(code(skeleton).match(/role="status"/g)?.length).toBe(1);
  });

  it("reserves the phone tap sizes the real controls carry, so the page does not jump (R3, G2)", () => {
    const skeleton = code(readFileSync(path.join(APP, "../../components/shell/route-skeleton.tsx"), "utf8"));
    expect(skeleton).toMatch(/h-11 w-full md:h-9/);
    expect(skeleton).toMatch(/h-11 min-w-11/);
  });

  it("is recorded beside the probe it satisfies", () => {
    const mobileFirst = readFileSync(path.join(REPO_ROOT, "docs/MOBILE_FIRST.md"), "utf8");
    expect(mobileFirst).toMatch(/src\/components\/shell\/route-skeleton\.tsx/);
  });
});
