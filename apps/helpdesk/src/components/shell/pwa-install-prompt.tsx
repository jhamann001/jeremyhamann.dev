"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

/**
 * Install prompt, and the service-worker registration that makes the app installable at all
 *.
 *
 * Rendered ONCE by the `(app)` layout. Two jobs, in one component because they are one feature:
 *
 *  1. **Register `/sw.js` — in a production build only.** A service worker in `next dev` serves a
 *     stale shell from a cache the dev server is simultaneously invalidating, which is a debugging
 *     trap that costs an afternoon. `process.env.NODE_ENV` is the flag, and the bundler INLINES it at
 *     build time — this is not `@/lib/env` and does not break G1 (a client component may not import
 *     the env module; it may read a compile-time constant). See the integration notes.
 *  2. **Offer to install, honestly, per platform.** Chromium fires `beforeinstallprompt`, which we
 *     capture and defer so the browser's own bar never appears uninvited; the button then replays it
 *     on a tap. iOS fires nothing and has no programmatic install, so Safari gets the Add-to-Home-Screen
 *     instructions instead of a button that cannot work. Every other browser gets nothing at all.
 *
 * DISMISSAL LIVES IN `localStorage` AND NOWHERE ELSE. Whether somebody wants the app on their home
 * screen is a per-device preference, not a fact about a person: it does not belong in the database,
 * it must not follow them to a different browser, and it is worth exactly zero rows in an evidentiary
 * ledger. Every access is wrapped — private mode and blocked site data both throw on read.
 */

/** The dismissal key. Namespaced so it cannot collide with anything else on the origin. */
export const INSTALL_DISMISS_KEY = "wmhd.pwa.install-dismissed-at" as const;

/** How long "Not now" lasts. Long enough not to nag; short enough that a new phone gets asked. */
export const INSTALL_DISMISS_DAYS = 60 as const;

export const SERVICE_WORKER_PATH = "/sw.js" as const;

/**
 * The reservation. The offer is a THIRD fixed element on the bottom edge, beside
 * `BottomNav` and `StickyActionBar`, and nothing made room for it: `<main>` reserves exactly one
 * `--wm-bottom-bar-h` (`pb-bar-safe`), which is the BAR's height and not the bar plus a three-line
 * card. So at full scroll the card floated over the last ~150 px of every screen at every width — six
 * covered controls on /dashboard at 360 and 430, the VOIDED "Entered in error" button and the swipe-nav
 * on /tickets/<id> at 390, the four pager buttons at 768 and 1280 — and its subtree, not the control
 * underneath, took the tap.
 *
 * So while it is on screen it publishes the clearance it needs on `<html>` and `#main` grows by exactly
 * that much through a pseudo-element (`src/app/globals.css`). A pseudo-element rather than padding
 * because neither the phone `pb-bar-safe` reservation nor the md+ `py-5` then has to be restated in a
 * second place, where it would drift. Both are removed the moment the offer goes away.
 */
export const INSTALL_OFFER_HEIGHT_PROPERTY = "--wm-install-offer-h" as const;

/** Present on `<html>` only while the offer is on screen; the reservation rule in globals.css is keyed to it. */
export const INSTALL_OFFER_ATTRIBUTE = "data-wm-install-offer" as const;

/**
 * How much clearance the offer needs BEYOND what `<main>` already reserves, in CSS pixels. Pure, so the
 * one piece of arithmetic that decides whether a control can be tapped is tested rather than eyeballed.
 *
 * `viewportHeight - offerTop` is the distance from the bottom of the viewport to the top of the fixed
 * offer — the strip of screen that must contain no content at full scroll. `<main>`'s own bottom padding
 * already clears part of it (one bar height plus the safe area on a phone, `py-5` at md+), and that part
 * is read from the element rather than restated here, so this holds at every width without knowing the
 * breakpoint. Never negative: an offer that needs less than `<main>` already gives reserves nothing.
 */
export function installOfferReservationPx(input: {
  viewportHeight: number;
  offerTop: number;
  mainPaddingBottom: number;
}): number {
  const clearance = input.viewportHeight - input.offerTop;
  return Math.max(0, Math.ceil(clearance - input.mainPaddingBottom));
}

/**
 * Whether to register the service worker at all. Pure, so the one condition that matters is tested
 * rather than asserted in a comment.
 */
export function shouldRegisterServiceWorker(input: {
  nodeEnv: string | undefined;
  hasServiceWorker: boolean;
  isSecureContext: boolean;
}): boolean {
  if (input.nodeEnv !== "production") return false;
  if (!input.hasServiceWorker) return false;
  // `localhost` counts as secure, so this only excludes a plain-http deployment — where a service
  // worker is unavailable anyway, and where nothing about this app should be running.
  return input.isSecureContext;
}

/**
 * iOS Safari, where "install" means the share sheet's Add to Home Screen.
 *
 * Chrome and Firefox ON iOS are deliberately excluded: they are WebKit underneath but their share
 * sheets differ, and a hint that names the wrong menu is worse than no hint (this component's own
 * rule). Everything else — including desktop Safari, which cannot install a web app — gets nothing.
 */
export function isIosSafari(userAgent: string): boolean {
  if (!/iPhone|iPad|iPod/i.test(userAgent)) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/i.test(userAgent)) return false;
  return /Safari/i.test(userAgent);
}

/** Already installed: nothing to offer, on any platform. */
export function isStandalone(input: { displayModeStandalone: boolean; navigatorStandalone: boolean }): boolean {
  return input.displayModeStandalone || input.navigatorStandalone;
}

/** A stored dismissal in milliseconds, or null when there is none or it is unreadable. */
export function parseDismissedAt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Has a "Not now" expired? A dismissal in the future (a moved clock) counts as current. */
export function dismissalExpired(dismissedAt: number | null, nowMs: number): boolean {
  if (dismissedAt === null) return true;
  return nowMs - dismissedAt > INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

export type InstallOffer = "none" | "prompt" | "ios";

/** The whole decision, as one pure function. */
export function installOffer(input: {
  standalone: boolean;
  hasDeferredPrompt: boolean;
  iosSafari: boolean;
  dismissedAt: number | null;
  nowMs: number;
}): InstallOffer {
  if (input.standalone) return "none";
  if (!dismissalExpired(input.dismissedAt, input.nowMs)) return "none";
  if (input.hasDeferredPrompt) return "prompt";
  return input.iosSafari ? "ios" : "none";
}

/** `beforeinstallprompt`, which no lib.dom in this repo declares. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function readDismissedAt(): number | null {
  try {
    return parseDismissedAt(window.localStorage.getItem(INSTALL_DISMISS_KEY));
  } catch {
    return null;
  }
}

function writeDismissedAt(nowMs: number): void {
  try {
    window.localStorage.setItem(INSTALL_DISMISS_KEY, String(nowMs));
  } catch {
    // Private mode, blocked site data, or a full quota. The banner simply reappears next session.
  }
}

export function PwaInstallPrompt(): React.JSX.Element | null {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [offer, setOffer] = useState<InstallOffer>("none");
  const offerRef = useRef<HTMLDivElement | null>(null);

  // --- 1. The service worker -------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    const registrable = shouldRegisterServiceWorker({
      nodeEnv: process.env.NODE_ENV,
      hasServiceWorker: "serviceWorker" in navigator,
      isSecureContext: window.isSecureContext,
    });
    if (!registrable) return;
    // Fire and forget: a failed registration means no offline page and no push, and neither is worth
    // an error anybody sees. The catch keeps an unhandled rejection out of the console on a browser
    // that refuses the scope.
    void navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: "/" }).catch(() => undefined);
  }, []);

  // --- 2. The offer ----------------------------------------------------------------------------
  const evaluate = useCallback((prompt: InstallPromptEvent | null) => {
    if (typeof window === "undefined") return;
    setOffer(
      installOffer({
        standalone: isStandalone({
          displayModeStandalone:
            typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches,
          navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
        }),
        hasDeferredPrompt: prompt !== null,
        iosSafari: isIosSafari(navigator.userAgent),
        dismissedAt: readDismissedAt(),
        nowMs: Date.now(),
      }),
    );
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onBeforeInstallPrompt = (event: Event): void => {
      // Without this the browser shows its own bar wherever it likes, including over the composer.
      event.preventDefault();
      const prompt = event as InstallPromptEvent;
      setDeferred(prompt);
      evaluate(prompt);
    };
    const onInstalled = (): void => {
      setDeferred(null);
      setOffer("none");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    // iOS never fires the event, so the first evaluation has to happen on mount as well.
    evaluate(null);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [evaluate]);

  // --- 3. The reservation -----------------------------------------------------------------------
  // See INSTALL_OFFER_HEIGHT_PROPERTY. Runs on every offer change because the card's height depends on
  // which offer is shown, and re-measures on resize and on any reflow of the card itself (a rotation,
  // a font-size change, the iOS hint wrapping to a third line). Everything is torn down on cleanup, so
  // a dismissed offer leaves no padding behind.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const node = offerRef.current;
    if (offer === "none" || node === null) return;
    const root = document.documentElement;

    const measure = (): void => {
      const main = document.getElementById("main");
      const px = installOfferReservationPx({
        viewportHeight: window.innerHeight,
        offerTop: node.getBoundingClientRect().top,
        mainPaddingBottom: main === null ? 0 : Number.parseFloat(window.getComputedStyle(main).paddingBottom) || 0,
      });
      root.style.setProperty(INSTALL_OFFER_HEIGHT_PROPERTY, `${px}px`);
      root.setAttribute(INSTALL_OFFER_ATTRIBUTE, "");
    };

    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.removeAttribute(INSTALL_OFFER_ATTRIBUTE);
      root.style.removeProperty(INSTALL_OFFER_HEIGHT_PROPERTY);
    };
  }, [offer]);

  const dismiss = useCallback(() => {
    writeDismissedAt(Date.now());
    setOffer("none");
  }, []);

  const install = useCallback(() => {
    if (deferred === null) return;
    void deferred.prompt().catch(() => undefined);
    void deferred.userChoice
      .then(() => {
        // Either way the event is spent: a browser fires `beforeinstallprompt` once per page load,
        // and replaying a consumed prompt throws.
        setDeferred(null);
        setOffer("none");
      })
      .catch(() => {
        setDeferred(null);
        setOffer("none");
      });
  }, [deferred]);

  if (offer === "none") return null;

  return (
    <div
      ref={offerRef}
      role="region"
      aria-label="Install WM Help Desk"
      className={cn(
        // Fixed, so it is inert to whatever container mounts it and cannot reflow the shell.
        // z-50, ABOVE both bottom bars (z-40): it used to share their level, so which of two
        // overlapping fixed elements painted on top was down to document order. It is never allowed to
        // cover content — see the reservation above — but when it sits beside a bar it is the thing in
        // front, not a card half-behind a tab rail. Portalled overlays (sheet, dialog, popover) are
        // also z-50 and are appended to <body> after this, so they still win.
        "fixed inset-x-0 z-50 px-safe",
        // Clear of the phone bottom bar (BottomNav / StickyActionBar share --wm-bottom-bar-h); at md+
        // there is no bottom bar, so it sits in the corner instead of spanning the width.
        "bottom-[calc(var(--wm-bottom-bar-h)+env(safe-area-inset-bottom,0px)+0.5rem)]",
        // md+: bottom-LEFT, offset past the 14rem sidebar (layout aside is w-56), so the offer never sits over
        // the ticket page's 340px right rail (Compliance inputs) — QA found it covering two inputs at 1280.
        "md:inset-x-auto md:left-[calc(14rem+1.5rem)] md:bottom-6 md:w-96 md:px-0",
      )}
    >
      <div className="flex items-start gap-3 rounded-xl border bg-card p-3 text-card-foreground shadow-lg">
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium md:text-sm">Install WM Help Desk</p>
          {offer === "prompt" ? (
            <p className="mt-0.5 text-base text-muted-foreground md:text-sm">
              Opens in its own window, with a badge for unread notifications.
            </p>
          ) : (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-base text-muted-foreground md:text-sm">
              <span>Tap</span>
              <Share aria-hidden className="size-4" />
              <span className="font-medium text-foreground">Share</span>
              <span>, then</span>
              <SquarePlus aria-hidden className="size-4" />
              <span className="font-medium text-foreground">Add to Home Screen</span>
              <span>.</span>
            </p>
          )}
          {offer === "prompt" ? (
            <Button type="button" size="sm" className="mt-2 min-h-11 md:min-h-9" onClick={install}>
              <Download aria-hidden />
              Install
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 md:min-h-9 md:min-w-9"
          aria-label="Not now"
          onClick={dismiss}
        >
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}
