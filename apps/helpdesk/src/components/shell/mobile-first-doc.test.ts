/**
 * Drift guard for `docs/MOBILE_FIRST.md`, which is *binding design* ("where the two disagree on
 * layout, this file wins"). A stale line there is not cosmetic: a reviewer running the §7 checklist
 * records failures that are not defects and passes surfaces the file never specified. Wave A drifted
 * on exactly three points before this guard existed — the dock item count, the Admin nav surface, and
 * the tap-target allowlist — so those three are asserted against the source of truth in `src/`.
 *
 * Same pattern as `src/app/(app)/tickets/[id]/streaming.test.ts`: read the shipped code and the
 * checklist, and fail when they describe different products. Deliberately keyed on facts (union
 * members, nav labels, the opt-out count), not on prose, so the file can be reworded freely.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DOC = readFileSync(path.join(ROOT, "docs/MOBILE_FIRST.md"), "utf8");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Every non-test `.ts`/`.tsx` file under `src/`, so the allowlist check cannot be fooled by a new directory. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("docs/MOBILE_FIRST.md matches the shipped shell", () => {
  it("documents every ticket-dock sheet the component can open", () => {
    const dock = read("src/components/ticket/ticket-action-dock.tsx");
    const union = /type DockSheet =([^;]+);/.exec(dock);
    expect(union, "DockSheet union not found — the dock was renamed or restructured").not.toBeNull();

    const members = [...(union?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(DOC, `§4.5 never mentions the "${member}" sheet`).toContain(`"${member}"`);
    }

    // §2's route rule and §2's screen inventory both print the bar, and the amendment banner repeats
    // it. EVERY printed copy must carry every item — one stale copy is what this guard exists for.
    const bars = [...DOC.matchAll(/←\s*Queue[^|\n]*?Reply/g)].map((m) => m[0]);
    expect(
      bars.length,
      "the dock bar is printed in at least §2's route rule and §2's screen inventory",
    ).toBeGreaterThanOrEqual(2);
    for (const bar of bars) {
      for (const label of ["Queue", "Details", "Actions", "Note", "Reply"]) {
        expect(bar, `the documented bar omits "${label}"`).toContain(label);
      }
    }
  });

  it("keeps the phone tab bar at five and documents the Admin overflow instead", () => {
    const nav = read("src/components/shell/nav-items.ts");
    // Scoped to `navItemsFor`'s body: Wave B added a second builder (`navOverflowFor`) whose entries
    // are not admin pages, and a file-wide match would have silently conflated the two lists.
    const navItemsBody = /export function navItemsFor[\s\S]*?\n}/.exec(nav)?.[0] ?? "";
    expect(navItemsBody, "navItemsFor's body could not be parsed").not.toBe("");
    const labels = [...navItemsBody.matchAll(/label:\s*"([A-Za-z ]+)"\s*}/g)].map((m) => m[1]);
    expect(labels, "navItemsFor's admin entries").toEqual([
      "Macros",
      "Users",
      "Held mail",
      // five more admin pages, none of which becomes a tab.
      "SLA policy",
      "Webhooks",
      "API tokens",
      "Suppression",
      "Capabilities",
    ]);

    // Wave B's non-admin overflow: Reports and the reply-review queue, which also never become tabs.
    const overflowBody = /export function navOverflowFor[\s\S]*?\n}/.exec(nav)?.[0] ?? "";
    const overflowLabels = [...overflowBody.matchAll(/label:\s*"([A-Za-z ]+)"\s*}/g)].map((m) => m[1]);
    // The portfolio demo's Outbox joins them in demo mode only (src/lib/demo/mode.ts).
    expect(overflowLabels, "navOverflowFor's entries").toEqual(["Reports", "Reply reviews", "Outbox"]);

    // The overflow rule itself: admin never becomes a sixth tab, and neither does anything Wave B added.
    expect(nav).toContain("adminOverflowFor");
    const bottomTabsBody = /function bottomTabsFor[\s\S]*?\n}/.exec(nav)?.[0] ?? "";
    expect(bottomTabsBody).not.toContain("admin");
    expect(bottomTabsBody, "the inbox is a topbar action on phones, not a sixth tab (Decision #108)").not.toContain(
      "inbox",
    );
    expect(bottomTabsBody).not.toContain("showReports");

    for (const label of [...labels, ...overflowLabels]) {
      expect(DOC, `§2 never names the "${label}" entry`).toContain(label);
    }
    // The two surfaces that render the same array are both named in the checklist.
    expect(DOC).toMatch(/Account sheet/);
    expect(DOC).toMatch(/Admin/);
    // Fix round 1 (round-1 finding). The two assertions below used to stop at the DERIVATION: they
    // proved `navOverflowFor` returned the right labels and never that anything rendered it. It did
    // not: `AccountSheet` imported only `adminOverflowFor`, so below 768 px /reports and
    // /compliance/reviews were reachable only by typing the URL. A builder nothing calls is not
    // navigation, so the guard now pins the CONSUMPTION on both surfaces.
    const accountSheet = read("src/components/shell/account-sheet.tsx");
    expect(accountSheet).toContain("adminOverflowFor");
    expect(accountSheet, "the Account sheet must RENDER the Wave B overflow, not just export it").toContain(
      "navOverflowFor",
    );
    // It renders the returned array, rather than importing the builder and dropping the result.
    expect(accountSheet).toMatch(/overflow\.map\(/);
    expect(accountSheet, "each overflow entry needs the shared icon, so the two surfaces cannot diverge").toContain(
      "OVERFLOW_NAV_ICONS",
    );
    const sidebar = read("src/components/app-sidebar.tsx");
    expect(sidebar).toContain("items.admin");
    expect(sidebar).toContain("items.showReports");
    expect(sidebar).toContain("items.showReviews");
  });

  it("lists every data-tap opt-out that exists, and no more", () => {
    const offenders = sourceFiles(path.join(ROOT, "src"))
      .filter((f) => /data-tap=["{]/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(offenders, "R3 opt-outs in src/").toEqual(["src/components/audit/audit-table.tsx"]);

    const allowlist = /\*\*Allowlist of `data-tap="none"` opt-outs:\*\*([^\n]+)/.exec(DOC);
    expect(allowlist, "§7 allowlist paragraph not found").not.toBeNull();
    expect(allowlist?.[1]).toContain("AuditTable");
    expect(allowlist?.[1]).toContain("Start from the newest row");
  });
});

/**
 * Fix round 2. The three assertions above cover the shell (dock union, admin labels, tap allowlist) and
 * caught nothing when §7 kept telling a reviewer to confirm `"Reply sent to client"` on a composer that
 * deliberately says no such thing. Wave A's binding copy rule is that **nothing claims delivery until a
 * delivery result exists** (the build record S3, the build record P16), so the words the
 * composer renders are product, not prose — a §7 run against the old wording records a FAIL on correct
 * code, which is exactly the failure mode this file exists to prevent.
 *
 * These are positive assertions only ("the doc contains what the component renders"), never "the doc
 * must not contain X": §7 and the amendment banner deliberately quote the retired wording to tell a
 * reviewer that seeing it means they are looking at pre-Wave-A code.
 */

/** A heading's body, up to the next heading of the same or higher level. */
function section(heading: string, sameLevel: RegExp): string {
  const start = DOC.indexOf(heading);
  expect(start, `"${heading}" not found in docs/MOBILE_FIRST.md`).toBeGreaterThanOrEqual(0);
  const rest = DOC.slice(start + heading.length);
  const end = rest.search(sameLevel);
  return end === -1 ? rest : rest.slice(0, end);
}

const QA = section("## (7) QA checklist", /\n## /);
const S43 = section("### 4.3 Dashboard + Queue page", /\n### /);
const S45 = section("### 4.5 Ticket detail", /\n### /);

/** The visible text of a `<Button>`, with icon elements and whitespace stripped. */
function buttonText(children: string): string {
  return children
    .replace(/<[^>]*\/>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("docs/MOBILE_FIRST.md matches the shipped composer copy", () => {
  const composer = read("src/components/ticket/composer.tsx");

  /** Extract exactly one capture group set, failing loudly rather than silently asserting nothing. */
  function once(re: RegExp, what: string): RegExpExecArray {
    const m = re.exec(composer);
    expect(m, `${what} not found in composer.tsx — it was renamed or restructured`).not.toBeNull();
    return m as RegExpExecArray;
  }

  it("§7 quotes the public-reply buttons the composer actually renders", () => {
    // One literal pattern per intent: a `new RegExp` built from a non-literal is a security scanner CWE-185
    // finding, and §7 only ever quotes these two reply buttons.
    for (const [intent, re] of [
      ["save", /data-intent="save"\s*>([\s\S]{0,300}?)<\/Button>/],
      ["pending", /data-intent="pending"\s*>([\s\S]{0,300}?)<\/Button>/],
    ] as const) {
      const m = once(re, `the "${intent}" reply button`);
      const label = buttonText(m[1]);
      expect(label.length, `the "${intent}" button renders no text`).toBeGreaterThan(0);
      expect(QA, `§7 never quotes the "${intent}" reply button label "${label}"`).toContain(label);
      expect(S45, `§4.5 never quotes the "${intent}" reply button label "${label}"`).toContain(label);
    }
  });

  it("§7 quotes the internal-note button, in both layouts", () => {
    const labels = [...composer.matchAll(/onClick=\{submitInternal\}[^>]*>([\s\S]{0,300}?)<\/Button>/g)].map((m) =>
      buttonText(m[1]),
    );
    // Inline and sheet layouts render the same button; a divergence here is itself a defect.
    expect(labels.length, "the internal-note submit button").toBeGreaterThanOrEqual(1);
    expect(new Set(labels).size, `the internal-note button renders different text per layout: ${labels.join(" / ")}`).toBe(1);
    expect(QA, `§7 never quotes the internal-note button label "${labels[0]}"`).toContain(labels[0]);
  });

  it("§7 quotes the confirm-dialog action and both success toasts", () => {
    const action = once(
      /confirmIntent === "pending" \? "([^"]+)" : "([^"]+)"\}/,
      "the AlertDialogAction label ternary",
    );
    const saved = once(
      /const saved = setPending \? "([^"]+)" : "([^"]+)";/,
      "the success-toast ternary",
    );
    const delivery = once(
      /deliveryQueued[\s\S]{0,40}?\?\s*"([^"]+)"[\s\S]{0,30}?:\s*"([^"]+)"/,
      "the delivery-outcome toast ternary",
    );
    for (const literal of [action[1], action[2], saved[1], saved[2], delivery[1], delivery[2]]) {
      expect(QA, `§7 never quotes the literal "${literal}"`).toContain(literal);
    }
  });
});

describe("docs/MOBILE_FIRST.md matches the shipped ticket page and dashboard header", () => {
  const page = read("src/app/(app)/tickets/[id]/page.tsx");
  const dashboard = read("src/components/dashboard/dashboard-view.tsx");

  it("§4.5's render block names every component the page mounts", () => {
    // Everything rendered as `<Name …` in the page body, minus the primitives the block elides.
    const rendered = new Set(
      [...page.matchAll(/<([A-Z][A-Za-z]*)[\s/>]/g)].map((m) => m[1]).filter((n) => n !== "Skeleton"),
    );
    for (const name of rendered) {
      expect(S45, `§4.5 never mentions <${name} />, which the ticket page renders`).toContain(name);
    }
    // The two streamed panels are the point: one mount point each, both behind Suspense.
    expect(page).toContain('variant="inline"');
    expect(page).toContain('variant="sheet"');
    for (const variant of ['variant="inline"', 'variant="sheet"']) {
      expect(S45, `§4.5 never documents RequesterHistory's ${variant}`).toContain(variant);
    }
    expect(S45, "§4.5 never documents the phone-only wrapper for the history sheet").toContain("md:hidden");
  });

  it("§4.3 documents the dashboard header's export control", () => {
    expect(dashboard, "the dashboard header no longer renders the export control").toContain("ExportTicketsButton");
    expect(S43, "§4.3 never mentions ExportTicketsButton").toContain("ExportTicketsButton");

    // If the export block is ever gated to md+, §4.3's phone paragraph is stale and must be revisited.
    const exportLine = /<ExportTicketsButton[^/]*\/>/.exec(dashboard)?.[0] ?? "";
    expect(exportLine, "ExportTicketsButton invocation").not.toContain("hidden md:");
  });

  it("§7 describes the move-queue control's read-only fallback, not a disabled Select", () => {
    const panel = read("src/components/ticket/properties-panel.tsx");
    const fallback = /if \(closed \|\| !ticket\.permissions\.canMove\) return <([A-Za-z]+)/.exec(panel);
    expect(fallback, "TicketMoveQueueControl's no-move fallback not found").not.toBeNull();
    expect(QA, `§7 never names <${fallback?.[1]} />, the control's no-move fallback`).toContain(fallback?.[1] ?? "");

    // Both reason sentences the dock prints under it are visible text, so §7 can assert them.
    const dock = read("src/components/ticket/ticket-action-dock.tsx");
    for (const reason of [...dock.matchAll(/"((?:Closed tickets|Your groups)[^"]+)"/g)].map((m) => m[1])) {
      expect(QA, `§7 never quotes the move-queue reason "${reason}"`).toContain(reason);
    }
  });
});

describe("docs/MOBILE_FIRST.md §7 G10 is runnable against the shipped DOM", () => {
  /** The G10 probe body, from its comment header up to the next probe. */
  const G10 = (() => {
    const start = QA.indexOf("// G10 —");
    expect(start, "§7 no longer contains a G10 probe").toBeGreaterThanOrEqual(0);
    const rest = QA.slice(start);
    const end = rest.indexOf("// G11");
    return end === -1 ? rest : rest.slice(0, end);
  })();

  it("excludes the bottom bar's own subtree when picking the last content element", () => {
    // Without this, `last` resolves to a node INSIDE the dock and the probe compares the bar against
    // itself: ok === false on a correct layout. QA hit exactly that on /tickets/[id] (a <span> reading
    // "Reply", bottom 833, against the dock's own top 783).
    expect(G10, "G10 never excludes the bar's descendants — it will compare the bar against itself")
      .toContain("bar.contains(e)");
    expect(G10, "G10 never excludes the bar element itself").toMatch(/e\s*!==\s*bar/);
    expect(G10, "G10 no longer filters by rendered height").toContain("getBoundingClientRect().height > 0");
    expect(G10, "G10 no longer compares the last content bottom against the bar top").toMatch(
      /lastBottom\s*<=\s*barTop\s*\+\s*1|bottom\s*<=\s*bar\.getBoundingClientRect\(\)\.top\s*\+\s*1/,
    );
  });

  it("names the bar and the landmark the shipped shell actually emits", () => {
    const layout = read("src/app/(app)/layout.tsx");
    const bar = read("src/components/shell/sticky-action-bar.tsx");
    const nav = read("src/components/shell/bottom-nav.tsx");

    expect(layout, "the (app) layout no longer renders <main id=\"main\">").toContain('<main id="main"');
    expect(bar, "StickyActionBar no longer carries the attribute G10 selects on").toContain(
      "data-sticky-action-bar",
    );
    expect(nav, "BottomNav no longer carries the attribute G10 selects on").toContain("data-bottom-nav");
    for (const selector of ["[data-bottom-nav]", "[data-sticky-action-bar]", "getElementById('main')"]) {
      expect(G10, `G10 no longer references ${selector}`).toContain(selector);
    }
  });

  it("is load-bearing: the dock really is a descendant of #main", () => {
    // The exclusion is not defensive tidiness. Chain: (app)/layout renders {children} inside
    // <main id="main"> → the ticket page renders <TicketActionDock> → the dock renders
    // <StickyActionBar> → StickyActionBar emits data-sticky-action-bar. So on /tickets/[id] the bar
    // is inside #main. (BottomNav is a SIBLING of <main>, which is why dashboard routes never
    // reproduced the false failure.)
    const layout = read("src/app/(app)/layout.tsx");
    const inMain = /<main id="main"[\s\S]*?\{children\}[\s\S]*?<\/main>/.exec(layout);
    expect(inMain, "the (app) layout no longer renders {children} inside <main id=\"main\">").not.toBeNull();
    expect(layout, "BottomNav is no longer a sibling of <main> — G10's premise changed").toMatch(
      /<\/main>\s*<BottomNav/,
    );

    expect(read("src/app/(app)/tickets/[id]/page.tsx")).toContain("<TicketActionDock");
    expect(read("src/components/ticket/ticket-action-dock.tsx")).toContain("<StickyActionBar");
    // /tickets/new mounts the same bar inside #main through the form, so the fix covers it too.
    expect(read("src/components/dashboard/new-ticket-form.tsx")).toContain("<StickyActionBar");
  });

  it("explains the exclusion in prose so the next editor does not strip it", () => {
    expect(G10, "G10 carries no note explaining why the bar's subtree is excluded").toMatch(/inside #main/i);
  });
});

describe("docs/MOBILE_FIRST.md §7 G2 is runnable against the shipped DOM", () => {
  /** The G2 probe body, from its comment header up to the next probe. */
  const G2 = (() => {
    const start = QA.indexOf("// G2 —");
    expect(start, "§7 no longer contains a G2 probe").toBeGreaterThanOrEqual(0);
    const rest = QA.slice(start);
    const end = rest.indexOf("// G3");
    return end === -1 ? rest : rest.slice(0, end);
  })();

  it("excludes aria-hidden subtrees, so Radix's native form shims are not counted", () => {
    // Fix round 2. Without this, /tickets/new at 390 px returned four offenders that no person can
    // tap — three SELECT at 1x1 and one INPUT[type=checkbox] at 16x16, all Radix's hidden native
    // form shims. The probe's own `r.width > 0` / `visibility !== 'hidden'` tests do NOT catch them
    // (the select shim is 1x1, the checkbox shim is opacity:0), so the screen failed a check §7
    // says must return [] with no real defect behind it.
    const closest = /!el\.closest\('([^']+)'\)/.exec(G2);
    expect(closest, "G2's closest() exclusion list not found — the probe was restructured").not.toBeNull();
    expect(
      closest?.[1],
      "G2 no longer excludes [aria-hidden=true]; it will report Radix's hidden native shims as tap-target defects",
    ).toContain("[aria-hidden=true]");

    // The exclusions it already had must survive alongside it.
    for (const slot of ["markdown", "alert-description", "sheet-description", "dialog-description"]) {
      expect(closest?.[1], `G2 no longer excludes [data-slot=${slot}]`).toContain(`[data-slot=${slot}]`);
    }
  });

  it("is load-bearing: /tickets/new mounts the Radix controls that emit those shims", () => {
    // Chain: the form renders shadcn Select/Checkbox → both wrap the radix-ui primitives → each
    // primitive renders an aria-hidden, tabindex="-1" native element (`select`, `input`) purely so
    // the control participates in form submission. Drop any link and the exclusion stops mattering.
    const form = read("src/components/dashboard/new-ticket-form.tsx");
    expect(form, "/tickets/new no longer renders a Select").toContain("@/components/ui/select");
    expect(form, "/tickets/new no longer renders a Checkbox").toContain("@/components/ui/checkbox");
    expect(read("src/components/ui/select.tsx"), "Select no longer wraps the radix primitive").toContain("radix-ui");
    expect(read("src/components/ui/checkbox.tsx"), "Checkbox no longer wraps the radix primitive").toContain(
      "radix-ui",
    );
  });

  it("explains the exclusion in prose so the next editor does not strip it", () => {
    expect(G2, "G2 carries no note explaining why aria-hidden subtrees are excluded").toMatch(/shim/i);
  });
});
