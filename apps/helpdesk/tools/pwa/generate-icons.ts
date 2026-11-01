/**
 * `npm run pwa:icons` — writes the committed PWA icon set (`pwa-push`).
 *
 * The outputs are GENERATED but COMMITTED, for the reason `src/app/layout.tsx` gives: a build must
 * never depend on a generator having been run, and a missing icon is a silent 404 rather than a loud
 * failure. Re-run this only when `mark.ts` changes, and commit what it writes.
 *
 * It reads nothing, sends nothing and touches no database. Output is byte-deterministic — the
 * rasteriser takes no random input and `deflateSync` at a fixed level is stable — so a re-run on an
 * unchanged `mark.ts` produces an unchanged tree, and `--check` asserts exactly that.
 *
 *   npx tsx tools/pwa/generate-icons.ts            # write
 *   npx tsx tools/pwa/generate-icons.ts --check    # exit 1 if anything on disk is stale
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png";
import { markSvg, renderMark, type MarkVariant } from "./mark";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const ICONS_DIR = path.join(ROOT, "public", "icons");

/**
 * Every icon the manifest and the root layout name, and nothing else.
 *
 * `icon-192` / `icon-512` are the `purpose: "any"` pair — rounded tile, transparent outside it, for a
 * launcher that does not mask. `icon-maskable-*` bleed to the edges with the artwork inside the 80%
 * safe zone, which is what Android's adaptive mask crops to. `apple-touch-icon` is 180 px, full-bleed
 * and never transparent: iOS composites a transparent touch icon onto black.
 */
export const ICON_SPECS: ReadonlyArray<{ file: string; size: number; variant: MarkVariant }> = [
  { file: "icon-192.png", size: 192, variant: "rounded" },
  { file: "icon-512.png", size: 512, variant: "rounded" },
  { file: "icon-maskable-192.png", size: 192, variant: "full" },
  { file: "icon-maskable-512.png", size: 512, variant: "full" },
  { file: "apple-touch-icon.png", size: 180, variant: "full" },
];

/** The SVG source of the mark, committed beside the PNGs so the drawing is editable by a human. */
export const SVG_FILE = "icon.svg" as const;

export type Artifact = { file: string; bytes: Uint8Array };

/** Builds every artifact in memory. Pure apart from the CPU it burns; the test calls this, not `main`. */
export function buildIcons(): Artifact[] {
  const out: Artifact[] = [{ file: SVG_FILE, bytes: new TextEncoder().encode(markSvg("rounded")) }];
  for (const spec of ICON_SPECS) {
    out.push({ file: spec.file, bytes: encodePng(renderMark(spec.size, spec.variant)) });
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const artifacts = buildIcons();
  if (!check) mkdirSync(ICONS_DIR, { recursive: true });

  const stale: string[] = [];
  for (const { file, bytes } of artifacts) {
    const target = path.join(ICONS_DIR, file);
    if (check) {
      let existing: Uint8Array | null = null;
      try {
        existing = new Uint8Array(readFileSync(target));
      } catch {
        existing = null;
      }
      if (existing === null || !equalBytes(existing, bytes)) stale.push(file);
      continue;
    }
    writeFileSync(target, bytes);
    process.stdout.write(`wrote public/icons/${file} (${bytes.length} bytes)\n`);
  }

  if (check) {
    if (stale.length > 0) {
      process.stderr.write(`stale icon artifacts: ${stale.join(", ")}\nrun: npm run pwa:icons\n`);
      return 1;
    }
    process.stdout.write("icons up to date\n");
  }
  return 0;
}

/** `tsx tools/pwa/generate-icons.ts` runs; an import (the test) does not. */
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
