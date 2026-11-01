/**
 * The install prompt's decisions.
 *
 * Two things this component must never do, both tested here: register a service worker outside a
 * production build (a stale shell served over a dev server costs an afternoon), and show a button
 * that cannot install anything (iOS fires no `beforeinstallprompt` and has no programmatic install,
 * so Safari gets instructions instead).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dismissalExpired,
  INSTALL_DISMISS_DAYS,
  INSTALL_DISMISS_KEY,
  INSTALL_OFFER_ATTRIBUTE,
  INSTALL_OFFER_HEIGHT_PROPERTY,
  installOffer,
  installOfferReservationPx,
  isIosSafari,
  isStandalone,
  parseDismissedAt,
  SERVICE_WORKER_PATH,
  shouldRegisterServiceWorker,
} from "@/components/shell/pwa-install-prompt";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("shouldRegisterServiceWorker", () => {
  it("registers only in a production build, on a secure context, where the API exists", () => {
    expect(shouldRegisterServiceWorker({ nodeEnv: "production", hasServiceWorker: true, isSecureContext: true })).toBe(
      true,
    );
    expect(SERVICE_WORKER_PATH).toBe("/sw.js");
  });

  it("never registers in development or test", () => {
    for (const nodeEnv of ["development", "test", undefined]) {
      expect(shouldRegisterServiceWorker({ nodeEnv, hasServiceWorker: true, isSecureContext: true }), String(nodeEnv)).toBe(
        false,
      );
    }
  });

  it("never registers without the API or outside a secure context", () => {
    expect(shouldRegisterServiceWorker({ nodeEnv: "production", hasServiceWorker: false, isSecureContext: true })).toBe(
      false,
    );
    expect(shouldRegisterServiceWorker({ nodeEnv: "production", hasServiceWorker: true, isSecureContext: false })).toBe(
      false,
    );
  });
});

describe("isIosSafari", () => {
  it("recognises iPhone and iPad Safari", () => {
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
  });

  it("excludes the other iOS browsers, whose share sheets differ", () => {
    expect(isIosSafari("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isIosSafari("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/130.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isIosSafari("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 EdgiOS/130.0 Mobile/15E148 Safari/604.1")).toBe(false);
  });

  it("excludes every non-iOS user agent, including desktop Safari", () => {
    expect(isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe(
      false,
    );
    expect(isIosSafari("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe(
      false,
    );
  });
});

describe("dismissal", () => {
  it("is namespaced and lives only in localStorage", () => {
    expect(INSTALL_DISMISS_KEY).toBe("wmhd.pwa.install-dismissed-at");
  });

  it("reads a stored timestamp and shrugs off anything else", () => {
    expect(parseDismissedAt(String(NOW))).toBe(NOW);
    for (const raw of [null, "", "nonsense", "0", "-5"]) expect(parseDismissedAt(raw), String(raw)).toBeNull();
  });

  it("expires after the stated window and not before", () => {
    expect(dismissalExpired(null, NOW)).toBe(true);
    expect(dismissalExpired(NOW - 1 * DAY, NOW)).toBe(false);
    expect(dismissalExpired(NOW - (INSTALL_DISMISS_DAYS - 1) * DAY, NOW)).toBe(false);
    expect(dismissalExpired(NOW - (INSTALL_DISMISS_DAYS + 1) * DAY, NOW)).toBe(true);
    // A clock that moved backwards must not resurrect the banner.
    expect(dismissalExpired(NOW + 5 * DAY, NOW)).toBe(false);
  });
});

describe("installOffer", () => {
  const base = { standalone: false, hasDeferredPrompt: false, iosSafari: false, dismissedAt: null, nowMs: NOW };

  it("offers nothing once the app is installed", () => {
    expect(isStandalone({ displayModeStandalone: true, navigatorStandalone: false })).toBe(true);
    expect(isStandalone({ displayModeStandalone: false, navigatorStandalone: true })).toBe(true);
    expect(isStandalone({ displayModeStandalone: false, navigatorStandalone: false })).toBe(false);
    expect(installOffer({ ...base, standalone: true, hasDeferredPrompt: true })).toBe("none");
    expect(installOffer({ ...base, standalone: true, iosSafari: true })).toBe("none");
  });

  it("offers the real prompt when the browser has given us one", () => {
    expect(installOffer({ ...base, hasDeferredPrompt: true })).toBe("prompt");
  });

  it("offers the Add-to-Home-Screen hint on iOS Safari, where there is no prompt to fire", () => {
    expect(installOffer({ ...base, iosSafari: true })).toBe("ios");
  });

  it("offers nothing on a browser that can neither prompt nor be instructed", () => {
    expect(installOffer(base)).toBe("none");
  });

  it("stays silent while a dismissal is current, on both platforms", () => {
    const dismissedAt = NOW - 1 * DAY;
    expect(installOffer({ ...base, hasDeferredPrompt: true, dismissedAt })).toBe("none");
    expect(installOffer({ ...base, iosSafari: true, dismissedAt })).toBe("none");
    expect(installOffer({ ...base, hasDeferredPrompt: true, dismissedAt: NOW - (INSTALL_DISMISS_DAYS + 1) * DAY })).toBe(
      "prompt",
    );
  });
});

/**
 * Fix round 2 — the offer used to cover the bottom of every screen.
 *
 * It is `position: fixed` on the bottom edge and nothing reserved room for it: `<main>` reserves exactly
 * one `--wm-bottom-bar-h` (`pb-bar-safe`), the height of the BAR, not of the bar plus a three-line card.
 * At full scroll QA measured six covered controls on /dashboard at 360 and 430, the VOIDED "Entered in
 * error" button and the swipe-nav on /tickets/<id> at 390 (Playwright refused the click — this region's
 * subtree intercepted the pointer), and the four pager buttons at 768 and 1280.
 *
 * Two halves, both asserted here because neither works alone: the arithmetic that decides how much room
 * to ask for, and the wiring between the component and the CSS rule that grants it.
 */
describe("the install offer reserves its own room", () => {
  it("asks for the clearance <main> does not already give, and never for less than none", () => {
    // Phone: main reserves one 56px bar; the offer sits 8px above it and is 96px tall. 8 + 96 = 104.
    expect(
      installOfferReservationPx({ viewportHeight: 800, offerTop: 800 - (56 + 8 + 96), mainPaddingBottom: 56 }),
    ).toBe(104);
    // md+: no bottom bar, main reserves py-5 (20px), the card floats 24px up and is 96px tall.
    expect(installOfferReservationPx({ viewportHeight: 800, offerTop: 800 - (24 + 96), mainPaddingBottom: 20 })).toBe(
      100,
    );
    // A safe-area inset is part of what main already reserves, so it must not be counted twice.
    expect(
      installOfferReservationPx({ viewportHeight: 800, offerTop: 800 - (56 + 34 + 8 + 96), mainPaddingBottom: 90 }),
    ).toBe(104);
    // An offer that needs less than main already reserves adds nothing — never a negative height.
    expect(installOfferReservationPx({ viewportHeight: 800, offerTop: 780, mainPaddingBottom: 56 })).toBe(0);
    // Sub-pixel heights round UP: half a pixel of overlap is still overlap.
    expect(installOfferReservationPx({ viewportHeight: 800, offerTop: 703.5, mainPaddingBottom: 56 })).toBe(41);
  });

  it("publishes the height and the flag the stylesheet keys on, and clears both", () => {
    const source = read("src/components/shell/pwa-install-prompt.tsx");
    const css = read("src/app/globals.css");

    // The two names are the whole contract between the component and the stylesheet. If either side
    // renames one, the offer silently goes back to covering content — so both sides are pinned here.
    expect(INSTALL_OFFER_HEIGHT_PROPERTY).toBe("--wm-install-offer-h");
    expect(INSTALL_OFFER_ATTRIBUTE).toBe("data-wm-install-offer");
    expect(css, "globals.css no longer grows #main while the offer is on screen").toContain(
      `:root[${INSTALL_OFFER_ATTRIBUTE}] #main::after`,
    );
    expect(css, "the reservation rule no longer reads the height the component publishes").toContain(
      `height: var(${INSTALL_OFFER_HEIGHT_PROPERTY}, 0px)`,
    );

    expect(source, "the component never sets the height property").toContain(
      "root.style.setProperty(INSTALL_OFFER_HEIGHT_PROPERTY",
    );
    expect(source, "the component never sets the flag the rule is keyed to").toContain(
      "root.setAttribute(INSTALL_OFFER_ATTRIBUTE",
    );
    // Cleanup is not tidiness: a reservation left behind after "Not now" is dead space on every page.
    expect(source, "the flag is never removed — a dismissed offer would leave the padding behind").toContain(
      "root.removeAttribute(INSTALL_OFFER_ATTRIBUTE)",
    );
    expect(source, "the height property is never removed").toContain(
      "root.style.removeProperty(INSTALL_OFFER_HEIGHT_PROPERTY)",
    );
    // It re-measures: the card's height depends on which offer is shown and on how its text wraps.
    expect(source, "the offer never re-measures on resize").toContain('window.addEventListener("resize", measure)');
    expect(source, "the offer never re-measures when the card itself reflows").toContain("ResizeObserver");
  });

  it("sits above both bottom bars rather than level with them", () => {
    const source = read("src/components/shell/pwa-install-prompt.tsx");
    const nav = read("src/components/shell/bottom-nav.tsx");
    const bar = read("src/components/shell/sticky-action-bar.tsx");
    // Both bars are z-40. Sharing that level left the painting order to the DOM, which is how a card
    // ends up half behind a tab rail.
    expect(nav).toContain("z-40");
    expect(bar).toContain("z-40");
    expect(source, "the install offer is back on the bars' stacking level").toContain('"fixed inset-x-0 z-50 px-safe"');
  });

  it("is selected by the G10 probe, which used to look at the two bars only", () => {
    const doc = read("docs/MOBILE_FIRST.md");
    const start = doc.indexOf("// G10 —");
    expect(start, "§7 no longer contains a G10 probe").toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start);
    const end = rest.indexOf("// G11");
    const probe = end === -1 ? rest : rest.slice(0, end);
    // The probe reads the DOM, so it must select on what this component actually emits.
    expect(probe, "G10 still ignores the install offer — the defect it missed in round 1").toContain(
      '[role=region][aria-label^="Install"]',
    );
    const source = read("src/components/shell/pwa-install-prompt.tsx");
    expect(source).toContain('role="region"');
    expect(source).toContain('aria-label="Install WM Help Desk"');
  });
});
