/**
 * Source guard for the three `/admin/*` surfaces (`/admin/macros`, `/admin/users`, `/admin/intake`).
 *
 * The repo has no DOM test environment, so this asserts the SHAPE of the client code the way
 * `requester-email-flow.test.ts` and `ticket-list-probe.test.ts` do. Each assertion below stands for a
 * defect that was measured at 390x844, not for a style preference:
 *
 *   - the clear-search button is 44 px wide on a phone and sits over the last 48 px of the field, so
 *     without right padding the caret and the tail of a typed mailbox ran underneath it;
 *   - `globals.css` gives a Button a 44 px minimum HEIGHT and no minimum width, so a short label
 *     ("All") measured 38x44 — the one G2 offender on all three pages. MOBILE_FIRST §7: an offender is
 *     fixed by giving the control the size, never by extending the `data-tap="none"` allowlist;
 *   - `AlertDialogContent` is centred with no ceiling and no scroller. Wave A put real forms inside it,
 *     and with `interactive-widget: "resizes-content"` an Android keyboard leaves roughly 390x400 — so
 *     the confirm button went off-screen with no way to reach it;
 *   - and the one that is not a layout defect at all: held mail needs a disposition that is not
 *     "release into a ticket". Five of the nine hold reasons are machine noise, `SuspendedIntake` rows
 *     can never be deleted, and until `discardHeldIntake` existed the `Discarded` filter chip had no
 *     producer — it could only ever render an empty list while the NEW queue grew without bound.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Every non-test `.tsx` under `dir`, recursively. Absolute paths. */
function tsxUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) tsxUnder(full, acc);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) acc.push(full);
  }
  return acc;
}

const VIEWS = {
  macros: "src/components/admin/macros/macros-admin-view.tsx",
  users: "src/components/admin/users/users-admin-view.tsx",
  intake: "src/components/admin/intake/held-intake-view.tsx",
} as const;

/** Every Wave A admin confirm that carries a form or a long consequence statement. */
const DIALOGS = [
  "src/components/admin/intake/release-intake-dialog.tsx",
  "src/components/admin/intake/discard-intake-dialog.tsx",
  "src/components/admin/users/user-active-dialog.tsx",
  "src/components/admin/macros/macro-active-dialog.tsx",
] as const;

describe("admin search fields keep their text clear of the clear button", () => {
  for (const [name, rel] of Object.entries(VIEWS)) {
    it(`${name}: the search Input reserves room on the right`, () => {
      const src = read(rel);
      const input = /<Input\b[\s\S]*?\/>/.exec(src)?.[0] ?? "";
      expect(input, `no <Input> found in ${rel}`).not.toBe("");
      expect(input).toContain('type="search"');
      // `pl-9` clears the leading Search icon; `pr-12` clears the 44 px trailing clear Button.
      expect(input).toMatch(/className="pl-9 pr-12(\s|")/);
    });

    it(`${name}: the clear control is still an icon Button pinned inside the field`, () => {
      const src = read(rel);
      expect(src).toContain('size="icon"');
      expect(src).toContain("absolute top-1/2 right-1 -translate-y-1/2");
    });
  }
});

describe("G2: no admin filter chip can fall under 44 px wide", () => {
  for (const [name, rel] of Object.entries(VIEWS)) {
    it(`${name}: every filter Button carries min-w-11`, () => {
      const src = read(rel);
      const buttons = src.match(/<Button\b[\s\S]*?>/g) ?? [];
      const filters = buttons.filter((b) => b.includes("aria-pressed"));
      expect(filters.length, `no aria-pressed filter Buttons found in ${rel}`).toBeGreaterThan(0);
      for (const b of filters) expect(b, b).toContain("min-w-11");
    });

    it(`${name}: does not opt out of the tap rule instead of sizing the control`, () => {
      expect(read(rel)).not.toContain('data-tap="none"');
    });
  }
});

describe("admin confirms fit a phone with the keyboard up", () => {
  for (const rel of DIALOGS) {
    it(`${rel.split("/").pop()}: AlertDialogContent has a ceiling and a scroller`, () => {
      const src = read(rel);
      const content = /<AlertDialogContent[\s\S]*?>/.exec(src)?.[0] ?? "";
      expect(content, `no <AlertDialogContent> in ${rel}`).not.toBe("");
      expect(content).toContain("max-h-[90svh]");
      expect(content).toContain("overflow-y-auto");
    });
  }
});

describe("held mail has a disposition that is not 'open a ticket'", () => {
  const view = read(VIEWS.intake);
  const action = read("src/server/held-intake-discard.actions.ts");
  const dialog = read("src/components/admin/intake/discard-intake-dialog.tsx");

  it("the DISCARDED filter chip has a producer", () => {
    // The chip is only honest if something writes the value it filters on.
    expect(view).toContain('{ key: "DISCARDED", label: "Discarded" }');
    expect(action).toContain('newValue: "DISCARDED"');
    expect(action).toContain('data: { status: "DISCARDED" }');
  });

  it("the discard is conditional on NEW, so a double tap cannot write two audit rows", () => {
    expect(action).toContain('where: { id: row.id, status: "NEW" }');
    expect(action).toContain("updateMany");
  });

  it("the transition and its audit row are in ONE transaction, audit last", () => {
    const tx = /withTx\(async \(tx\) => \{[\s\S]*?\n    \}\);/.exec(action)?.[0] ?? "";
    expect(tx, "the withTx block was restructured").not.toBe("");
    expect(tx.indexOf("updateMany")).toBeLessThan(tx.indexOf("writeAuditMany"));
    expect(action.match(/writeAuditMany/g) ?? []).toHaveLength(2); // the import and the one call
  });

  it("the reviewer's reason is required and sanitized before it reaches the ledger", () => {
    expect(action).toContain("sanitizePII(data.reason)");
    expect(action).toContain(".min(3,");
    expect(dialog).toContain("REASON_MIN");
    expect(dialog).toContain("disabled={pending || tooShort}");
  });

  it("the wording never claims a deletion, a ticket or a reply", () => {
    expect(dialog).toContain("marked, never deleted");
    expect(dialog).toContain("nothing is sent to");
    expect(dialog).toContain("No ticket is created");
    expect(dialog).toContain("There is no undo");
    // The only permitted use of "delete" on this surface is the denial of one.
    for (const m of dialog.match(/[^.“”]*\bdelet\w+[^.“”]*/gi) ?? []) {
      expect(m, m).toMatch(/never deleted|not deleted/);
    }
  });

  it("every NEW row on the page offers it, and a row with no usable sender offers only it", () => {
    expect(view).toContain("<DiscardIntakeDialog");
    expect(view).toContain("row.hasUsableSender ? (");
    // The release control is rendered only on the branch where the action can actually succeed.
    const releaseAt = view.indexOf("<ReleaseIntakeDialog");
    const branchAt = view.indexOf("row.hasUsableSender ? (");
    expect(branchAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(branchAt);
  });
});

describe("the held-mail counts describe the rows on screen", () => {
  const view = read(VIEWS.intake);
  const page = read("src/app/(app)/admin/intake/page.tsx");
  const reads = read("src/server/suspended-intake.ts");

  it("the page asks for counts under the status and mailbox it is showing", () => {
    expect(page).toContain("heldIntakeCounts(viewer, ctx, { status, mailbox: mailbox || undefined })");
  });

  it("the reason chips read the scoped counts and the banner reads the NEW backlog", () => {
    expect(view).toContain("counts.byReason[r]");
    expect(view).toContain("counts.waitingTotal");
    expect(view).toContain("counts.waitingUnauthenticated");
  });

  it("the NEW backlog is counted on its own query, so widening the filter cannot move it", () => {
    expect(reads).toContain("waitingTotal");
    expect(reads).toContain('where: { status: "NEW" }');
  });
});

/**
 * Fix round 1. `/admin/sla` is outside the `VIEWS` map above, and it is the one Wave B admin page whose
 * primary controls are `Switch`es — 32x18, and `[data-slot=switch]` is deliberately NOT in the phone
 * tap rule in `src/app/globals.css` (widening the track would break the thumb's `translate-x`). The
 * page's own comment claimed the row was the target while the wrapper was a plain `<div>` with no
 * `onClick` and no `htmlFor`, so three G2 offenders measured 32x18 at 390x844 with nothing else to hit.
 *
 * MOBILE_FIRST §7: an offender is fixed by giving the control the size, never by extending the
 * `data-tap="none"` allowlist.
 */
describe("the /admin/sla auto-assignment rows are tappable", () => {
  const rel = "src/components/admin/sla/sla-admin-view.tsx";

  it("wraps the whole row in one Label that names the switch, at least 44 px tall", () => {
    const src = read(rel);
    const label = /<Label\s+htmlFor=\{id\}[\s\S]*?>/.exec(src.slice(src.indexOf("<Switch") - 4000)) ?? null;
    expect(label, "no <Label htmlFor={id}> near the Switch").not.toBeNull();
    expect(label?.[0]).toContain("min-h-11");
    // Exactly one `htmlFor={id}` in the auto-assignment row: nested labels are invalid, and two
    // labels for one control is how the 18 px text node became the only alternative target.
    const rowStart = src.indexOf("data-auto-assign");
    expect(rowStart, "the auto-assignment row was renamed").toBeGreaterThan(-1);
    const row = src.slice(rowStart);
    expect([...row.matchAll(/htmlFor=\{id\}/g)].length, "one label per switch").toBe(1);
  });

  it("does not claim a wrapper is the tap target without making it one", () => {
    const src = read(rel);
    expect(src).not.toContain("the tap target is the label row plus this wrapper");
    expect(src).not.toContain('data-tap="none"');
  });
});

/**
 * Fix round 1. The `min-w-11` assertion above is per-view and only covers the three Wave A admin
 * views, so `/inbox`'s "All" chip shipped at 39x44 — the global phone rule sets a minimum HEIGHT and
 * no minimum width, and the neighbouring "Unread" chip escaped only because its label plus the unread
 * `Badge` happened to be wider. That makes the failure label-length dependent and it returns the
 * moment a short chip is added, so the guard is by DIRECTORY now, not by a hand-kept map.
 *
 * Still not project-wide: several `aria-pressed` Buttons elsewhere are full-width or carry long
 * labels and belong to other surfaces' owners. These three directories are the filter-chip surfaces.
 */
describe("every filter chip on the chip surfaces carries the width floor", () => {
  const CHIP_ROOTS = ["src/components/admin", "src/components/inbox", "src/components/reports"];

  it("finds the chips at all", () => {
    const n = CHIP_ROOTS.flatMap((r) => tsxUnder(path.join(ROOT, r)))
      .map((f) => readFileSync(f, "utf8"))
      .flatMap((src) => (src.match(/<Button\b[\s\S]*?>/g) ?? []).filter((b) => b.includes("aria-pressed")));
    expect(n.length).toBeGreaterThanOrEqual(6);
  });

  it("gives every aria-pressed Button a minimum width", () => {
    const offenders: string[] = [];
    for (const file of CHIP_ROOTS.flatMap((r) => tsxUnder(path.join(ROOT, r)))) {
      const src = readFileSync(file, "utf8");
      for (const b of (src.match(/<Button\b[\s\S]*?>/g) ?? []).filter((x) => x.includes("aria-pressed"))) {
        if (!b.includes("min-w-11")) offenders.push(`${path.relative(ROOT, file)}: ${b.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    }
    expect(offenders, "aria-pressed chips with no width floor").toEqual([]);
  });
});

/**
 * Fix round 1. The forwarded-mail release was server-complete and operator-unreachable.
 *
 * `releaseHeldIntake` has accepted `releaseAsCandidate` since B9, `resolveForwardedRelease` re-checks
 * it against the stored `SuspendedIntake.candidateRequesterEmail`, and the column is populated on
 * every `FORWARDED` hold — but no component read that address, nothing rendered it, and nothing in
 * the tree ever sent the flag. `/admin/intake` therefore showed a forwarded client message with two
 * buttons, neither of which could attribute it to the client, so the whole path was dead code from an
 * operator's point of view (B9's "UI delta for /admin/intake (unowned) not built", still open after
 * integration).
 *
 * The three assertions below are the three links in that chain: the DTO carries the address, the card
 * shows it, and the dialog offers the choice and sends the BOOLEAN — never an address — for it.
 */
describe("the forwarded-mail release is reachable from /admin/intake", () => {
  const DTO = "src/server/suspended-intake.ts";
  const CARD = "src/components/admin/intake/held-intake-view.tsx";
  const DIALOG = "src/components/admin/intake/release-intake-dialog.tsx";

  it("the row DTO carries the parsed candidate, narrowed to FORWARDED holds", () => {
    const src = read(DTO);
    expect(src).toMatch(/candidateRequesterEmail: string \| null;/);
    expect(src, "the column has to be selected to be projected").toContain("candidateRequesterEmail: true");
    // A non-FORWARDED reason can never render the choice, whatever the column happens to hold.
    expect(src).toMatch(/candidateRequesterEmail:\s*r\.reason === "FORWARDED" \? r\.candidateRequesterEmail : null/);
  });

  it("the card shows the candidate and hands it to the release control", () => {
    const src = read(CARD);
    expect(src).toContain("FORWARDED: \"Forwarded message\"");
    expect(src, "no 'Appears to be from' line on the card").toContain("Appears to be from {row.candidateRequesterEmail}");
    expect(src, "the dialog never receives the address").toContain(
      "candidateRequesterEmail={row.candidateRequesterEmail}",
    );
  });

  it("the dialog offers the choice, defaults to the forwarder, and sends a boolean", () => {
    const src = read(DIALOG);
    // Rendered only where the parser actually read an inner sender.
    expect(src).toContain('data-control="forwarded-attribution"');
    expect(src).toContain("candidateRequesterEmail === null ? null : (");
    // The forwarder is the default: the hold exists so a human attributes the message.
    expect(src).toMatch(/useState<"sender" \| "candidate">\("sender"\)/);
    // What crosses the wire is the flag, and only for the candidate choice. An address field here
    // would be an unaudited way to point a ticket anywhere at all — `changeRequesterEmail` is the
    // gated path for that.
    expect(src).toContain('attribution === "candidate" ? { releaseAsCandidate: true } : {}');
    const payload = /await releaseHeldIntake\(\{[\s\S]*?\}\);/.exec(src)?.[0] ?? "";
    expect(payload, "no releaseHeldIntake call found").not.toBe("");
    expect(payload, "the client must never send the address itself").not.toMatch(
      /releaseAsCandidate:\s*candidateRequesterEmail|requesterEmail:/,
    );
    // R3: both radio rows are label rows with the 44 px floor, like the unverified-sender checkbox.
    const rows = src.match(/<label[\s\S]*?htmlFor=\{`attr-[\s\S]*?className="[^"]*"/g) ?? [];
    expect(rows.length, "both attribution rows are label rows").toBe(2);
    for (const row of rows) expect(row, row).toContain("min-h-11");
  });
});

/**
 * Fix round 1. The one-time reveal panel outlived the credential it was showing.
 *
 * `router.refresh()` re-renders the list from the server and leaves client state alone, so revoking a
 * token whose plaintext was on screen left "Copy this now — it is not shown again" rendering a full
 * credential that had already stopped working (verified: a machine call with it 401'd immediately
 * while the block was still painted). The value is dead, so the harm is low — but the page whose
 * subject is credential hygiene was telling an administrator to save a dead secret, and holding a
 * plaintext on screen past the point its own contract implies.
 */
describe("the API-token reveal panel does not outlive its credential", () => {
  const VIEW = "src/components/admin/api-tokens/api-tokens-admin-view.tsx";
  const DIALOG = "src/components/admin/api-tokens/token-lifecycle-dialog.tsx";

  it("a successful revoke reports the token it killed", () => {
    const src = read(DIALOG);
    expect(src).toContain("onRevoked?: (tokenId: string) => void;");
    // Only on a revoke, only on success: a failed action must not clear a panel that is still true.
    expect(src).toMatch(/if \(revoking\) onRevoked\?\.\(token\.id\);/);
    const ok = /if \(result\.ok\) \{[\s\S]*?return;\s*\}/.exec(src)?.[0] ?? "";
    expect(ok, "no success branch found").not.toBe("");
    expect(ok).toContain("onRevoked?.(token.id)");
  });

  it("the page clears the reveal only when it is the revoked token's own plaintext", () => {
    const src = read(VIEW);
    expect(src).toMatch(/current\.token\.id === tokenId \? null : current/);
    // Wired to the revoke dialog; rotation keeps its own path, which REPLACES the secret.
    expect(src).toContain("onRevoked={onRevoked}");
    expect(src).toContain("onRevoked={clearRevealedIfRevoked}");
  });
});

/**
 * Fix round 2. `/admin/macros` had horizontal page scroll at 360 and 390 — `documentElement.scrollWidth`
 * 404 against `innerWidth` 390 — and the single offender was one `Badge` per macro-action SENTENCE.
 *
 * `describeMacroActions` deliberately returns whole sentences ("Set the status to Pending client, when
 * the state machine allows it"), and the shadcn Badge primitive is `inline-flex h-5 w-fit shrink-0 …
 * whitespace-nowrap`: the text can neither wrap nor shrink, so it pushes straight through the gutter.
 * `[data-slot=badge]` is deliberately NOT in the phone rules in `src/app/globals.css`, so no global
 * rule catches this — and the composer's `MacroEffects` renders the identical strings as wrapping
 * `<li>`s, so one macro was being described with two layout behaviours.
 *
 * A Badge is for a LABEL from a closed set (a status, a queue, a group). The guard is by directory, not
 * on the one call site, because the next sentence-in-a-badge will be written somewhere else.
 */
describe("R2: a macro-action sentence never goes in a nowrap Badge", () => {
  it("the /admin/macros summary renders the sentences as wrapping list items", () => {
    const src = read(VIEWS.macros);
    const fn = /function MacroActionsSummary\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(fn, "MacroActionsSummary not found").not.toBe("");
    expect(fn, "a Badge is h-5 shrink-0 whitespace-nowrap — a sentence in one overflows 360 px").not.toContain(
      "<Badge",
    );
    expect(fn, "the sentences must be able to wrap").toContain("<li");
    // Same shape as the composer's MacroEffects, which is where these strings already wrapped correctly.
    expect(fn).toContain("list-disc");
  });

  it("no Badge anywhere under src/components/admin renders a describeMacroActions line", () => {
    const offenders: string[] = [];
    for (const file of tsxUnder(path.join(ROOT, "src/components/admin"))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("describeMacroActions")) continue;
      // Every variable the sentence list is mapped over, whatever the list itself was called.
      const lists = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*describeMacroActions\(/g)].map((m) => m[1]);
      expect(lists.length, `describeMacroActions used but never bound in ${path.relative(ROOT, file)}`).toBeGreaterThan(
        0,
      );
      // Both patterns below were `new RegExp(...)` built from `list` / `item` — two security scanner CWE-185
      // findings on this block. the build record: the pattern is
      // a LITERAL that CAPTURES the identifier, and the run-time value is compared as a string.
      //
      // `[^>]*` keeps the match inside ONE opening tag: an unbounded `[\s\S]*?` would happily run from
      // some earlier <Badge> all the way to a correctly-rendered {line} further down the file.
      const badgeChildren = new Set([...src.matchAll(/<Badge\b[^>]*>\s*\{(\w+)\}/g)].map((m) => m[1]));
      for (const list of lists) {
        // `<list>.map((<item>)` — scanned, because the needle is a run-time string with no pattern in
        // it. Same acceptance as the regex: the identifier has to be word characters up to the `)`.
        const needle = `${list}.map((`;
        for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + needle.length)) {
          const from = at + needle.length;
          const close = src.indexOf(")", from);
          if (close === -1) break;
          const item = src.slice(from, close);
          if (item.length === 0 || !/^\w+$/.test(item)) continue;
          if (badgeChildren.has(item)) offenders.push(`${path.relative(ROOT, file)}: <Badge>{${item}}</Badge>`);
        }
      }
    }
    expect(offenders, "macro-action sentences rendered in a whitespace-nowrap Badge").toEqual([]);
  });
});
