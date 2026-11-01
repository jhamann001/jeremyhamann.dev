/**
 * The drift guard for the service-worker routing build (`tools/pwa/build-sw.ts`).
 *
 * `tools/pwa/sw-logic.js` is the source of the worker's routing decision; the marked section of
 * `public/sw.js` is the artifact the browser runs. Two copies of the same code are only safe if CI
 * refuses to let them differ, and that is this file's whole job:
 *
 *  1. the shipped worker's ROUTING section equals the module's marked region, byte for byte;
 *  2. re-rendering `public/sw.js` from the module reproduces the file exactly, so a rebuild is a
 *     no-op and `--check` never reports a difference nobody made;
 *  3. everything OUTSIDE the markers is the worker's own and is copied through untouched — a build
 *     cannot quietly rewrite the fetch handler or the push listeners;
 *  4. the shipped region is still classic script (no `import`, no `export`, no TypeScript), because
 *     `public/` is served without a bundler;
 *  5. the tool actually repairs drift, and refuses a file with a missing or duplicated marker
 *     (exercised against a temporary copy, never the real tree).
 *
 * `tools/pwa/sw.test.ts` is the other half: it imports the module and calls it. Together they mean
 * the behaviour tests run the same bytes the browser runs, with no `new Function` anywhere
 * (CWE-95).
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LOGIC_BEGIN,
  LOGIC_END,
  LOGIC_FILE,
  REPO_ROOT,
  SW_BEGIN,
  SW_END,
  SW_FILE,
  buildServiceWorker,
  checkServiceWorker,
  extractRegion,
  readRoutingRegion,
  renderServiceWorker,
  shippedRoutingRegion,
} from "./build-sw";

const temps: string[] = [];

/** A throwaway copy of just the two files the build touches. */
function scratchRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "wm-sw-build-"));
  temps.push(root);
  mkdirSync(path.join(root, "tools", "pwa"), { recursive: true });
  mkdirSync(path.join(root, "public"), { recursive: true });
  cpSync(path.join(REPO_ROOT, LOGIC_FILE), path.join(root, LOGIC_FILE));
  cpSync(path.join(REPO_ROOT, SW_FILE), path.join(root, SW_FILE));
  return root;
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("the module and the shipped worker agree", () => {
  it("public/sw.js carries exactly the module's marked region", () => {
    expect(shippedRoutingRegion()).toBe(readRoutingRegion());
  });

  it("re-renders byte-identically from the module", () => {
    const render = renderServiceWorker();
    expect(render.drifted).toBe(false);
    expect(render.next).toBe(render.current);
  });

  it("checkServiceWorker writes nothing", () => {
    const before = readFileSync(path.join(REPO_ROOT, SW_FILE), "utf8");
    checkServiceWorker();
    expect(readFileSync(path.join(REPO_ROOT, SW_FILE), "utf8")).toBe(before);
  });

  it("the generated region is the whole routing decision and nothing else", () => {
    const region = readRoutingRegion();
    for (const name of [
      "function decideFetchStrategy",
      "function mayStoreResponse",
      "function parsePushPayload",
      "function isApiPath",
      "var SHELL_CACHE",
      "var PRECACHE_PATHS",
      "var STATIC_PREFIXES",
    ]) {
      expect(region, name).toContain(name);
    }
    // The lifecycle belongs to the worker, not to the module: a build must never be able to move it.
    for (const name of ["self.addEventListener", "function handleNavigate", "function handleStatic"]) {
      expect(region, name).not.toContain(name);
    }
  });

  it("the shipped region is still classic script — public/ has no bundler", () => {
    const region = readRoutingRegion();
    expect(region).not.toMatch(/^\s*import\s/m);
    expect(region).not.toMatch(/^\s*export\s/m);
    expect(region).not.toMatch(/\bimportScripts\s*\(/);
    // The `export` list that makes the module testable sits OUTSIDE the markers, so it is not shipped.
    const module_ = readFileSync(path.join(REPO_ROOT, LOGIC_FILE), "utf8");
    expect(module_).toMatch(/^export \{/m);
    expect(readFileSync(path.join(REPO_ROOT, SW_FILE), "utf8")).not.toMatch(/^export \{/m);
  });
});

describe("the build repairs drift", () => {
  it("rewrites a hand-edited worker back to the module, and leaves the rest of the file alone", () => {
    const root = scratchRoot();
    const before = readFileSync(path.join(root, SW_FILE), "utf8");

    // A hand-edit inside the marked region: exactly the state this build exists to make impossible.
    const opened = before.indexOf(SW_BEGIN) + SW_BEGIN.length;
    const closed = before.indexOf(SW_END, opened);
    const tampered = `${before.slice(0, opened)}\nvar CACHE_VERSION = "tampered";\n${before.slice(closed)}`;
    writeFileSync(path.join(root, SW_FILE), tampered, "utf8");

    expect(renderServiceWorker(root).drifted).toBe(true);
    const built = buildServiceWorker(root);
    expect(built).not.toBeNull();
    expect(readFileSync(path.join(root, SW_FILE), "utf8")).toBe(before);
    // Second run is a no-op.
    expect(buildServiceWorker(root)).toBeNull();
  });

  it("copies everything outside the markers through untouched", () => {
    const root = scratchRoot();
    const before = readFileSync(path.join(root, SW_FILE), "utf8");
    const marker = "// a comment only this test writes\n";
    writeFileSync(path.join(root, SW_FILE), before + marker, "utf8");

    // Drift the module's region so the build definitely rewrites the file.
    const module_ = readFileSync(path.join(root, LOGIC_FILE), "utf8");
    writeFileSync(
      path.join(root, LOGIC_FILE),
      module_.replace(LOGIC_END, `\nvar SW_LOGIC_TEST_ONLY = 1;${LOGIC_END}`),
      "utf8",
    );

    expect(buildServiceWorker(root)).not.toBeNull();
    const after = readFileSync(path.join(root, SW_FILE), "utf8");
    expect(after.endsWith(marker)).toBe(true);
    expect(after).toContain("var SW_LOGIC_TEST_ONLY = 1;");
    expect(after.slice(0, after.indexOf(SW_BEGIN))).toBe(before.slice(0, before.indexOf(SW_BEGIN)));
  });
});

describe("extractRegion refuses a file it cannot read unambiguously", () => {
  const body = `head\n${LOGIC_BEGIN}middle${LOGIC_END}\ntail\n`;

  it("returns the region between the markers", () => {
    expect(extractRegion(body, LOGIC_BEGIN, LOGIC_END, "fixture")).toBe("middle");
  });

  it("throws when a marker is missing", () => {
    expect(() => extractRegion("head\ntail\n", LOGIC_BEGIN, LOGIC_END, "fixture")).toThrow(/no .*begin/);
    expect(() => extractRegion(`head\n${LOGIC_BEGIN}middle\n`, LOGIC_BEGIN, LOGIC_END, "fixture")).toThrow(
      /no .*end/,
    );
  });

  it("throws when a marker is duplicated — which region was meant is not the build's guess to make", () => {
    expect(() => extractRegion(body + body, LOGIC_BEGIN, LOGIC_END, "fixture")).toThrow(/more than one/);
  });
});
