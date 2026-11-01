/**
 * Source guard for the TICKET surface, the sibling of `src/components/admin/admin-surface-probe.test.ts`.
 *
 * That file's doc block records a dialog defect measured at 390x844 on `/admin/*` and fixed there. It
 * was never extended to `/tickets/[id]`, which is where Wave B added a fifth `AlertDialog` — the
 * retraction confirm, which carries a required >= 12-character `Textarea` plus a three-clause
 * consequence paragraph, so the on-screen keyboard is necessarily up while the operator reads it. With
 * `interactive-widget: "resizes-content"` (src/app/layout.tsx) that leaves roughly 390x400, and the
 * uncapped dialog measured 477 px tall with `maxHeight: none`, `overflowY: visible` and
 * `scrollHeight === clientHeight` — no internal scrolling was possible at all, and "Keep the reply"
 * sat below the fold with no way to reach it. Withdrawing a reply is irreversible and audited
 * (`COMMENT_RETRACTED` + `MESSAGE_CANCELLED`).
 *
 * The second guard is the one that is invisible at typecheck: `src/components/ui/button.tsx` sets
 * `data-slot="button"` BEFORE spreading `{...props}`, so a caller that passes its own `data-slot`
 * silently replaces it — and the phone tap rule in `src/app/globals.css` is keyed on
 * `:where([data-slot=button], …)`. Two Wave B controls did exactly that and measured 88x24 and 24 px
 * tall. A QA hook belongs on `data-control`; `data-slot` belongs to the primitive.
 *
 * Same technique as the admin probe and `requester-email-flow.test.ts`: the repo has no DOM test
 * environment (`vitest.config.mts` runs `environment: "node"`), so this asserts the SHAPE of the
 * client source.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Every non-test `.tsx` under `dir`, relative to ROOT. */
function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, acc);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) acc.push(path.relative(ROOT, full));
  }
  return acc;
}

/**
 * The opening tags in `src`, as `[tagName, text]`. Walks forward from each `<Name` balancing braces
 * and quotes rather than matching `[^>]*`, because a prop value routinely contains `=>` and `>`.
 */
function openingTags(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const starts = [...src.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)];
  for (const m of starts) {
    const from = m.index ?? 0;
    let depth = 0;
    let quote: string | null = null;
    for (let i = from + 1; i < src.length; i += 1) {
      const c = src[i];
      if (quote !== null) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        out.push([m[1], src.slice(from, i + 1)]);
        break;
      }
    }
  }
  return out;
}

describe("ticket-surface confirms fit a phone with the keyboard up", () => {
  const files = tsxFiles(path.join(ROOT, "src/components/ticket")).filter((f) =>
    /<AlertDialogContent\b/.test(read(f)),
  );

  it("finds the ticket surface's AlertDialogs at all", () => {
    // Five at the time of writing: the retraction confirm, the reply confirm, the edit sheet's
    // confirm, the queue-move confirm and the attachment-removal confirm.
    expect(files.length, "no <AlertDialogContent> under src/components/ticket/**").toBeGreaterThanOrEqual(5);
  });

  for (const rel of files) {
    it(`${rel.split("/").pop()}: every AlertDialogContent has a ceiling and a scroller`, () => {
      const contents = openingTags(read(rel)).filter(([tag]) => tag === "AlertDialogContent");
      expect(contents.length, `no <AlertDialogContent> parsed in ${rel}`).toBeGreaterThan(0);
      for (const [, text] of contents) {
        expect(text, text).toContain("max-h-[90svh]");
        expect(text, text).toContain("overflow-y-auto");
      }
    });
  }

  it("keeps the ceiling in the primitive too, so a new dialog inherits it", () => {
    const primitive = read("src/components/ui/alert-dialog.tsx");
    // To the next top-level declaration: the destructured parameter list closes with its own `}`.
    const base = /function AlertDialogContent[\s\S]*?(?=\nfunction |\nexport )/.exec(primitive)?.[0] ?? "";
    expect(base, "AlertDialogContent not found in the primitive").not.toBe("");
    expect(base).toContain("max-h-[90svh]");
    expect(base).toContain("overflow-y-auto");
  });
});

/**
 * G2 on the two controls the `data-slot` override had silently exempted. MOBILE_FIRST §7: an offender
 * is fixed by giving the control the height, never by extending the `data-tap="none"` allowlist —
 * extending that list is an architecture decision needing an entry in MOBILE_FIRST *and* in
 * ARCHITECTURE. `md:min-h-0` releases the floor on a pointer device, which is the same recipe §7
 * records for the two ticket-header cross-links.
 */
describe("G2: the ticket surface's own controls carry the 44 px floor on a phone", () => {
  const CONTROLS = [
    // "Withdraw this reply" measured 88x24 at 360, 390 and 430, and it is the entry point to an
    // irreversible, audited action (COMMENT_RETRACTED + MESSAGE_CANCELLED).
    ["src/components/ticket/comment-item.tsx", "withdraw-reply"],
    ["src/components/ticket/composer.tsx", "discard-draft"],
  ] as const;

  for (const [rel, control] of CONTROLS) {
    it(`${control}: is sized rather than opted out`, () => {
      const src = read(rel);
      const tag = openingTags(src).find(
        ([tagName, text]) => tagName === "Button" && text.includes(`data-control="${control}"`),
      );
      expect(tag, `no <Button data-control="${control}"> in ${rel}`).toBeDefined();
      const text = tag?.[1] ?? "";
      expect(text, text).toContain("min-h-11");
      expect(text, text).not.toContain('data-tap="none"');
    });
  }

  it("the ticket surface adds no new data-tap opt-out", () => {
    for (const rel of tsxFiles(path.join(ROOT, "src/components/ticket"))) {
      expect(read(rel), rel).not.toContain('data-tap="none"');
    }
  });
});

describe("no caller outside src/components/ui overrides a primitive's data-slot", () => {
  /** Component names `src/components/ui/**` exports — i.e. every shadcn primitive in this repo. */
  const PRIMITIVES = new Set(
    tsxFiles(path.join(ROOT, "src/components/ui")).flatMap((rel) =>
      [...read(rel).matchAll(/^function ([A-Z][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]),
    ),
  );

  it("knows what the primitives are", () => {
    expect(PRIMITIVES.has("Button")).toBe(true);
    expect(PRIMITIVES.has("Badge")).toBe(true);
    expect(PRIMITIVES.has("AlertDialogContent")).toBe(true);
  });

  it("finds no data-slot override anywhere under src/", () => {
    const offenders: string[] = [];
    for (const rel of tsxFiles(path.join(ROOT, "src")).filter((f) => !f.startsWith("src/components/ui/"))) {
      for (const [tag, text] of openingTags(read(rel))) {
        if (!PRIMITIVES.has(tag)) continue;
        if (/\sdata-slot=/.test(text)) offenders.push(`${rel}: <${tag} … data-slot=…>`);
      }
    }
    // `data-slot` is the primitive's own identity and globals.css's phone tap rule is keyed on it, so
    // an override is a silently disabled accessibility rule. Use `data-control` for a QA hook.
    expect(offenders, "data-slot overrides on shadcn primitives").toEqual([]);
  });
});

/**
 * Fix round 2 — the defect class that took the ticket detail page down.
 *
 * `links-panel.tsx` is an async SERVER component and it called `linkKindLabel`, which was exported from
 * `link-kind-icon.tsx` — a `"use client"` module. Next turns EVERY export of a client module into a
 * client reference, so the call threw at render, the `(app)` boundary replaced the whole page, and
 * because a `TicketLink` is read from both ends ONE link row bricked TWO ticket pages — with the Remove
 * control living inside the panel that no longer rendered.
 *
 * Typecheck cannot see this: the import is type-correct and the failure is a runtime boundary. So it is
 * swept here. A COMPONENT export (PascalCase) is fine — a client reference is exactly what a client
 * component should be. A plain function or constant (camelCase / SCREAMING_CASE) is not: it must live
 * in a module with no directive, where both sides can call it.
 */
describe("no module without \"use client\" imports a non-component export from a client module", () => {
  const SRC = path.join(ROOT, "src");

  /**
   * Every `.ts`/`.tsx` under src/. Tests are kept as IMPORT TARGETS (so a client module is recognised
   * wherever it lives) but skipped as importers: vitest runs in node with no RSC boundary at all, so a
   * test importing a pure helper out of a `"use client"` module is how those helpers are pinned here
   * and in `swipe-nav.test.ts`. It is shipped code calling across the boundary that throws.
   */
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (/\.tsx?$/.test(entry)) acc.push(path.relative(ROOT, full));
    }
    return acc;
  }

  const isTestFile = (rel: string): boolean => /\.test\.tsx?$/.test(rel);

  const isClientModule = (src: string): boolean => /^\s*(["'])use client\1\s*;?/.test(src);

  /** `@/x/y` → `src/x/y.ts` or `.tsx`, when that file exists. */
  function resolveAlias(spec: string): string | null {
    if (!spec.startsWith("@/")) return null;
    const base = path.join(SRC, spec.slice(2));
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      try {
        const full = `${base}${ext}`;
        statSync(full);
        return path.relative(ROOT, full);
      } catch {
        // not this extension
      }
    }
    return null;
  }

  /** Named VALUE imports (not `import type`, not `type X` specifiers) from `spec`, as written. */
  function namedValueImports(src: string): Array<[string, string[]]> {
    const out: Array<[string, string[]]> = [];
    for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
      if (m[1]) continue; // `import type { … }` is erased; it cannot call anything.
      const names = m[2]
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n.length > 0 && !n.startsWith("type "))
        .map((n) => (n.split(/\s+as\s+/)[0] ?? "").trim())
        .filter((n) => n.length > 0);
      if (names.length > 0) out.push([m[3] ?? "", names]);
    }
    return out;
  }

  it("finds the client modules it is supposed to be checking", () => {
    expect(isClientModule(read("src/components/ticket/links/link-kind-icon.tsx"))).toBe(true);
    expect(isClientModule(read("src/components/ticket/links/links-panel.tsx"))).toBe(false);
  });

  it("finds no server-side call into a client module anywhere under src/", () => {
    const files = sourceFiles(SRC);
    const clientness = new Map<string, boolean>();
    for (const rel of files) clientness.set(rel, isClientModule(read(rel)));

    const offenders: string[] = [];
    for (const rel of files) {
      if (clientness.get(rel) === true) continue; // client → client is fine.
      if (isTestFile(rel)) continue; // node, no boundary — see sourceFiles.
      for (const [spec, names] of namedValueImports(read(rel))) {
        const target = resolveAlias(spec);
        if (target === null || clientness.get(target) !== true) continue;
        // A component is a client reference by design; anything else is called, and would throw.
        const nonComponents = names.filter((n) => !/^[A-Z]/.test(n));
        for (const n of nonComponents) offenders.push(`${rel} imports ${n} from ${spec} ("use client")`);
      }
    }
    expect(offenders, "non-component exports of client modules imported by non-client modules").toEqual([]);
  });
});
