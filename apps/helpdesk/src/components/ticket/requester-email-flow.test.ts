/**
 * Source guard for the two-step requester-address flow (see `edit-ticket-sheet.tsx`'s header and
 * the build record).
 *
 * The repo has no DOM test environment, so this asserts the SHAPE of the client code the way
 * `src/app/(app)/tickets/[id]/streaming.test.ts` and `ticket-list-probe.test.ts` do. What it protects is
 * a security control, not a layout: `updateTicketFields` refuses to re-point an address that is already
 * stored, so a form that keeps sending one through that action is a refusal the operator meets on
 * submit — and, worse, a form that ever stops refusing would be redirecting client correspondence with
 * no confirmation and no recorded reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SHEET = path.join(ROOT, "src/components/ticket/edit-ticket-sheet.tsx");
const sheet = readFileSync(SHEET, "utf8");

/** Every non-test `.ts`/`.tsx` under `src/components/`. */
function componentFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) componentFiles(full, acc);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("requester-address change is a confirmed second step, never a field edit", () => {
  it("the sheet imports changeRequesterEmail and is the only component that calls it", () => {
    expect(sheet).toContain("changeRequesterEmail");

    const callers = componentFiles(path.join(ROOT, "src/components"))
      .filter((f) => /\bchangeRequesterEmail\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(callers).toEqual(["src/components/ticket/edit-ticket-sheet.tsx"]);
  });

  it("buildPatch can only CLEAR or FIRST-adopt — neither a redirect nor a re-adoption is assemblable", () => {
    const fn = /function buildPatch\(\)[\s\S]*?\n  }/.exec(sheet)?.[0] ?? "";
    expect(fn, "buildPatch not found — the form was restructured").not.toBe("");
    // A CLEAR needs a stored address to clear.
    expect(fn).toContain("currentEmail.length > 0 && nextEmail.length === 0");
    // An ADOPT needs an empty column AND an address that has never been moved away from. Without the
    // `!addressIsPrivileged` clause, CLEAR-then-ADOPT composes back into the redirect that round 2
    // split out.
    expect(fn).toContain("currentEmail.length === 0 && nextEmail.length > 0 && !addressIsPrivileged");
  });

  it("a privileged address is read-only in the form and has its own second-step affordance", () => {
    expect(sheet).toContain("const hasStoredEmail = storedEmail.length > 0;");
    // The controls attach to the column's HISTORY, not its current value: a cleared address is still
    // privileged, so the form must not hand the operator a plain field the server is going to refuse.
    expect(sheet).toContain(
      "const addressIsPrivileged = hasStoredEmail || requesterEmailChangedAt !== null;",
    );
    expect(sheet).toContain("readOnly={addressIsPrivileged && !fieldsDisabled}");
    expect(sheet).toContain("data-change-requester-email");
    expect(sheet).toContain("Change address");
  });

  it("nothing in the form gates the second step on the CURRENT value alone", () => {
    // `hasStoredEmail` may still decide COPY ("the address on this ticket" is false after a clear), but
    // never whether the field is editable, whether the affordance renders, or what buildPatch sends.
    for (const gate of [
      "readOnly={hasStoredEmail",
      "{hasStoredEmail ? (\n                  <div",
      "!hasStoredEmail)",
    ]) {
      expect(sheet, `stale current-value gate: ${gate}`).not.toContain(gate);
    }
  });

  it("the sheet takes the ledger instant as a prop, and the page feeds every mount the same one", () => {
    expect(sheet).toContain("requesterEmailChangedAt?: string | null;");
    const page = readFileSync(path.join(ROOT, "src/app/(app)/tickets/[id]/page.tsx"), "utf8");
    // One read, one value, so the header banner and both edit mounts cannot disagree.
    expect(page).toContain("const requesterEmailChangedIso = requesterEmailChanged?.toISOString() ?? null;");
    expect(page.match(/requesterEmailChangedIso/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const panel = readFileSync(path.join(ROOT, "src/components/ticket/properties-panel.tsx"), "utf8");
    expect(panel).toContain("requesterEmailChangedAt={requesterEmailChangedAt}");
    const header = readFileSync(path.join(ROOT, "src/components/ticket/ticket-header.tsx"), "utf8");
    expect(header).toContain("requesterEmailChangedAt={requesterEmailChangedAt}");
  });

  it("the second step sends an explicit confirmation and a reason, and refuses an empty one client-side", () => {
    const handler = /function onRedirectSubmit\([\s\S]*?\n  }\n/.exec(sheet)?.[0] ?? "";
    expect(handler, "onRedirectSubmit not found").not.toBe("");
    expect(handler).toContain("confirm: true");
    expect(handler).toContain("reason,");
    expect(handler).toContain("REDIRECT_REASON_MIN");
    // A stale version token must surface as the CONFLICT dialog, not as a silent retry.
    expect(handler).toContain('result.code === "CONFLICT"');
  });

  it("read-only tickets cannot reach the second step", () => {
    // The dialog's submit returns early, and the trigger is disabled with the rest of the form.
    expect(/function onRedirectSubmit\([\s\S]*?if \(readOnly\) return;/.test(sheet)).toBe(true);
    expect(sheet).toContain("disabled={fieldsDisabled}\n                      onClick={openRedirect}");
  });
});

/**
 * Fix round 2 — one modal layer at a time. `TicketActionDock` hoists `RecordContactSheet` to the top
 * level and closes the Actions sheet first ("two stacked bottom sheets over a 360 px screen is not a
 * usable dialog"); the same rule binds the app's one privileged control, which used to open a centred
 * `Dialog` on top of a 90 svh bottom sheet.
 */
describe("the redirect step is hoisted, not stacked on the edit sheet", () => {
  it("no Dialog primitive is imported into the edit sheet any more", () => {
    expect(sheet).not.toContain('from "@/components/ui/dialog"');
    expect(sheet).not.toContain("<DialogContent");
  });

  it("opening the redirect step closes the edit sheet in the same tick", () => {
    const fn = /function openRedirect\(\)[\s\S]*?\n  }/.exec(sheet)?.[0] ?? "";
    expect(fn, "openRedirect not found — the flow was restructured").not.toBe("");
    expect(fn).toContain("setOpen(false)");
    expect(fn).toContain("setRedirectOpen(true)");
    // setOpen(false) must come first, so the two sheets are never both open in one render.
    expect(fn.indexOf("setOpen(false)")).toBeLessThan(fn.indexOf("setRedirectOpen(true)"));
  });

  it("backing out restores the edit sheet without re-seeding the half-typed form", () => {
    const fn = /function closeRedirect\(\)[\s\S]*?\n  }/.exec(sheet)?.[0] ?? "";
    expect(fn, "closeRedirect not found").not.toBe("");
    expect(fn).toContain("setRedirectOpen(false)");
    expect(fn).toContain("restoringEditRef.current = true");
    expect(fn).toContain("setOpen(true)");
    // The open-transition seeder must honour that flag, or a cancelled redirect wipes the edit form.
    expect(sheet).toContain("if (open && !wasOpen.current && restoringEditRef.current)");
  });

  it("a successful change closes both layers and never re-opens the edit sheet", () => {
    const handler = /function onRedirectSubmit\([\s\S]*?\n  }\n/.exec(sheet)?.[0] ?? "";
    const success = handler.slice(handler.indexOf("toast.success"));
    expect(success).toContain("reopenEditRef.current = false");
    expect(success).toContain("setRedirectOpen(false)");
    expect(success).toContain("setOpen(false)");
  });

  it("the redirect step renders as a ResponsiveSheet with its own footer and close rules", () => {
    expect(sheet).toContain('title="Change the requester address"');
    expect(sheet).toContain("showCloseButton={!redirectPending}");
    expect(sheet).toContain("onClick={closeRedirect}");
  });
});
