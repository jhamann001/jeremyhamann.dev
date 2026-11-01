/**
 * Fix round 2 — notification preferences, out of office and the push opt-in must exist at every width.
 *
 * They shipped inside `AccountSheet`, which only `BottomNav` renders; `BottomNav` is `md:hidden` and
 * additionally returns null on every `/tickets/**` route. So the controls existed below 768 px and
 * nowhere else: an ops lead on a laptop could not set "I am away until Tuesday, hand my tickets to
 * Sam", and a supervisor could not turn a notification kind off. Out of office is not decoration —
 * `outOfOfficeUntil` and `backupUserId` are the two columns B4's job reads to hand a person's open
 * tickets to their backup, so a desk that cannot set them loses the handover silently.
 *
 * These are source-shape assertions, like `mobile-first-doc.test.ts` beside them: the components are
 * client-only React and nothing here renders a DOM. What they pin is the thing that actually broke —
 * a settings block reachable from exactly one surface — plus the rule that keeps the fix honest: BOTH
 * surfaces render the SAME component, so they cannot drift into offering different settings.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const BLOCK = read("src/components/shell/notification-settings.tsx");
const SHEET = read("src/components/shell/account-sheet.tsx");
const TOPBAR = read("src/components/topbar.tsx");
const LAYOUT = read("src/app/(app)/layout.tsx");

describe("the notification settings block", () => {
  it("is one component holding both controls, not a block each surface writes out", () => {
    expect(BLOCK).toContain("export function NotificationSettingsControls");
    // The button that opens B1's form, and the per-device opt-in beside it.
    expect(BLOCK, "the block no longer offers the preferences form").toContain("Notification settings");
    expect(BLOCK, "the block no longer hosts the web-push opt-in").toContain("<PushSubscribe");
    // The form itself is B1's and is imported, never reimplemented: it owns outOfOfficeUntil/backupUserId.
    expect(BLOCK).toContain("NotificationPrefsSheet");
    // G1: a client component may not read the env module. Both values arrive as props from the server.
    // Matched on the IMPORT, not the string: the file names the rule it obeys in its own comments.
    expect(BLOCK, "a client component must not import @/lib/env (G1)").not.toMatch(/from "@\/lib\/env"/);
  });

  it("is rendered by the phone Account sheet", () => {
    expect(SHEET, "the Account sheet no longer renders the shared block").toContain(
      "<NotificationSettingsControls",
    );
    // It must not keep a second copy of the controls beside the shared one.
    expect(SHEET, "the Account sheet still renders its own PushSubscribe — two copies will drift").not.toContain(
      "<PushSubscribe",
    );
  });

  it("is rendered at md+ as well, which is the defect this test exists for", () => {
    expect(BLOCK).toContain("export function AccountSettingsMenu");
    expect(BLOCK, "the md+ menu no longer renders the SAME block the phone renders").toContain(
      "<NotificationSettingsControls",
    );
    expect(TOPBAR, "the topbar has no settings entry — the md+ gap is back").toContain("<AccountSettingsMenu");
    // In the topbar's md+ cluster: the phone surface is the Account sheet and must not gain a duplicate.
    expect(TOPBAR).toContain('className="hidden shrink-0 items-center gap-1 md:flex"');
    // An icon-only control needs an accessible name.
    expect(BLOCK).toContain('aria-label="Settings"');
  });

  it("gets its push props from the server on both paths", () => {
    // `PushSubscribe` renders nothing unless BOTH arrive, so an md+ surface wired to neither would look
    // correct and offer nothing. The layout is the only place that may read the env module.
    expect(LAYOUT).toContain("isWebPushEnabled(env)");
    for (const prop of ["pushEnabled={pushEnabled}", "vapidPublicKey={pushEnabled ? (env.VAPID_PUBLIC_KEY ?? null) : null}"]) {
      const uses = LAYOUT.split(prop).length - 1;
      expect(uses, `${prop} reaches fewer than both of <Topbar> and <BottomNav>`).toBeGreaterThanOrEqual(2);
    }
    expect(TOPBAR).toContain("pushEnabled");
    expect(TOPBAR).toContain("vapidPublicKey");
  });

  it("is written down where the next reader looks", () => {
    const doc = read("docs/MOBILE_FIRST.md");
    // §2's Account-sheet inventory never listed the block, which is why losing it at md+ went unnoticed.
    expect(doc, "MOBILE_FIRST §2 never names the notification preferences form").toContain(
      "NotificationPrefsSheet",
    );
    expect(doc, "MOBILE_FIRST §2 never names out of office as something this block sets").toContain(
      "outOfOfficeUntil",
    );
    expect(doc, "MOBILE_FIRST §2 never names the md+ surface for it").toContain("NotificationSettingsControls");
  });
});
