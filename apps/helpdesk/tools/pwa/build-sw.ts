/**
 * The service-worker routing build: `tools/pwa/sw-logic.js` is the source, the marked section of
 * `public/sw.js` is the artifact.
 *
 * WHY THIS EXISTS. `public/sw.js` is served from `public/` as-is — no bundler, no imports, classic
 * script — so the only way to unit-test its routing decision used to be to read the file, slice the
 * pure section out of it and evaluate the string: `new Function(pureSection())` in
 * `tools/pwa/sw.test.ts`. security scanner reports that as "Unsafe Evaluation of User Input in JavaScript"
 * (CWE-95), and the rule's own remedy is "import the logic as a module".
 * This build is what makes that possible without changing one byte of what the browser runs, and it
 * is deliberately the same arrangement Wave A used for the n8n Code nodes
 * (`tools/n8n/build-workflows.ts`, the build record):
 *
 *   - the routing decision lives in `tools/pwa/sw-logic.js`, written at column 0 between the
 *     `sw:routing` markers and exported at the bottom, so the tests import and CALL it;
 *   - this tool copies that region into `public/sw.js` between its ROUTING markers **byte for byte**,
 *     so the shipped worker is still the same plain classic script it always was — registration,
 *     scope, caching behaviour and the `/public` serving path are untouched;
 *   - `tools/pwa/build-sw.test.ts` runs {@link checkServiceWorker} in CI, so a module edited without
 *     a rebuild (or a hand-edit inside `public/sw.js`'s marked region) fails the build rather than
 *     shipping two different versions of the same routing decision.
 *
 * USAGE
 *   npx tsx tools/pwa/build-sw.ts            # rewrite public/sw.js from the module
 *   npx tsx tools/pwa/build-sw.ts --check    # report drift, change nothing, exit 1 if any
 *
 * WHY A MARKED REGION RATHER THAN A TRANSFORM. The comparison has to be exact, and a "strip the
 * exports and dedent" step is a transformation that can be wrong in ways nobody notices. The markers
 * make the copy a substring operation with no transformation at all, which is why the module writes
 * the region at column 0 in the worker's own dialect.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this file rather than from `process.cwd()`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The module that owns the routing decision, relative to the repository root. */
export const LOGIC_FILE = path.join("tools", "pwa", "sw-logic.js");

/** The shipped worker, relative to the repository root. */
export const SW_FILE = path.join("public", "sw.js");

/** Opening marker in the module. The newline is part of it, so the region starts on the next line. */
export const LOGIC_BEGIN = "/* sw:routing:begin */\n";
/** Closing marker in the module. The newline is part of it, so the region has no trailing newline. */
export const LOGIC_END = "\n/* sw:routing:end */";

/** Opening marker in `public/sw.js`. Unchanged from before this build existed. */
export const SW_BEGIN = "// --- WM-PWA ROUTING (pure) — BEGIN ---\n";
/** Closing marker in `public/sw.js`. Unchanged from before this build existed. */
export const SW_END = "\n// --- WM-PWA ROUTING (pure) — END ---";

/**
 * The text between `begin` and `end` in `source`, verbatim.
 *
 * Throws rather than returning a partial match: a file that lost a marker must fail the build, not
 * silently ship an empty routing section — a service worker whose `decideFetchStrategy` is missing
 * throws on every fetch event.
 */
export function extractRegion(source: string, begin: string, end: string, label: string): string {
  const openedAt = source.indexOf(begin);
  if (openedAt === -1) throw new Error(`${label}: no ${begin.trim()} marker`);
  if (source.indexOf(begin, openedAt + 1) !== -1) throw new Error(`${label}: more than one ${begin.trim()} marker`);
  const start = openedAt + begin.length;
  const closedAt = source.indexOf(end, start);
  if (closedAt === -1) throw new Error(`${label}: no ${end.trim()} marker after the opening one`);
  if (source.indexOf(end, closedAt + 1) !== -1) throw new Error(`${label}: more than one ${end.trim()} marker`);
  return source.slice(start, closedAt);
}

/** The routing region the module says the worker should carry. */
export function readRoutingRegion(root: string = REPO_ROOT): string {
  return extractRegion(readFileSync(path.join(root, LOGIC_FILE), "utf8"), LOGIC_BEGIN, LOGIC_END, LOGIC_FILE);
}

/** The routing region `public/sw.js` currently carries. */
export function shippedRoutingRegion(root: string = REPO_ROOT): string {
  return extractRegion(readFileSync(path.join(root, SW_FILE), "utf8"), SW_BEGIN, SW_END, SW_FILE);
}

/** `public/sw.js` as it is, and as the module says it should be. */
export type ServiceWorkerRender = {
  /** Path relative to the repository root. */
  file: string;
  current: string;
  next: string;
  /** True when the marked region differs — i.e. the routing decision itself drifted. */
  drifted: boolean;
};

/**
 * Renders `public/sw.js` from the module.
 *
 * Only the marked region is replaced. Everything else in the worker — the docstring, the lifecycle
 * listeners, the fetch handler, the push handlers — is the worker's own and is copied through
 * untouched, so a no-drift render is byte-identical to the file on disk.
 */
export function renderServiceWorker(root: string = REPO_ROOT): ServiceWorkerRender {
  const current = readFileSync(path.join(root, SW_FILE), "utf8");
  const shipped = extractRegion(current, SW_BEGIN, SW_END, SW_FILE);
  const wanted = readRoutingRegion(root);

  const openedAt = current.indexOf(SW_BEGIN) + SW_BEGIN.length;
  const closedAt = current.indexOf(SW_END, openedAt);
  const next = current.slice(0, openedAt) + wanted + current.slice(closedAt);

  return { file: SW_FILE, current, next, drifted: shipped !== wanted };
}

/** Read-only: nothing is written. */
export function checkServiceWorker(root: string = REPO_ROOT): ServiceWorkerRender {
  return renderServiceWorker(root);
}

/** Writes the rendered worker back. Returns the render when it changed, null when it was already current. */
export function buildServiceWorker(root: string = REPO_ROOT): ServiceWorkerRender | null {
  const render = renderServiceWorker(root);
  if (render.next === render.current) return null;
  writeFileSync(path.join(root, render.file), render.next, "utf8");
  return render;
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const render = renderServiceWorker();
  const stale = render.next !== render.current;

  if (check) {
    if (!stale) {
      process.stdout.write(`pwa: ${render.file} matches ${LOGIC_FILE}, no drift\n`);
      return 0;
    }
    process.stdout.write(`pwa: ${render.file} is stale — its ROUTING section differs from ${LOGIC_FILE}\n`);
    process.stdout.write("pwa: run `npx tsx tools/pwa/build-sw.ts` to regenerate\n");
    return 1;
  }

  if (!stale) {
    process.stdout.write("pwa: already up to date\n");
    return 0;
  }
  writeFileSync(path.join(REPO_ROOT, render.file), render.next, "utf8");
  process.stdout.write(`pwa: wrote ${render.file}\n`);
  return 0;
}

// Run only when invoked as a script; importing this module (the tests do) must have no side effect.
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
