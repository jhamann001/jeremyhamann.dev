"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Web-push opt-in.
 *
 * `enabled` is `isWebPushEnabled(env)`, resolved on the SERVER and passed down — a client component
 * may not import `@/lib/env`. When it is false this renders **nothing at all**: an opt-in
 * toggle for a channel the deployment cannot send on is a promise the desk will not keep. With the
 * three `VAPID_*` keys unset — every environment on this branch — that is the only path taken.
 *
 * `vapidPublicKey` is a PUBLIC key by construction: it is handed to every browser that subscribes,
 * and the browser bakes it into the subscription so the push service can check the sender is us.
 * Passing it to the client is the mechanism, not a leak.
 *
 * **Permission is requested on an explicit tap and never on mount.** A browser asked for notification
 * permission by a page the user did not act on usually refuses permanently, and there is no way back
 * from `denied` except the site settings — so a denied browser is told what happened in words rather
 * than being left with a toggle that silently springs back.
 *
 * It talks to `POST`/`DELETE /api/push/subscribe` rather than to the server action directly, because
 * `public/sw.js` uses the same route from `pushsubscriptionchange` where there is no page: one
 * surface, one validator, one pair of audit rows.
 */

export type PushSubscribeProps = { enabled: boolean; vapidPublicKey: string | null };

/** The route both this component and the service worker use. */
export const PUSH_SUBSCRIBE_PATH = "/api/push/subscribe" as const;

/**
 * base64url → the `Uint8Array` `pushManager.subscribe` wants for `applicationServerKey`.
 *
 * `atob` needs standard base64 with padding; the key travels as unpadded base64url. Pure and
 * exported so the conversion is unit-tested — it is the one piece of this component that is silently
 * wrong rather than loudly wrong when it is off by a character.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(base64Url)) throw new Error("applicationServerKey is not base64url");
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** What the control can be in. Each one renders differently, and none of them lies. */
export type PushState = "unsupported" | "denied" | "off" | "on" | "busy";

/** The state to show, given what the browser reports. Pure. */
export function pushState(input: {
  supported: boolean;
  permission: "default" | "granted" | "denied";
  subscribed: boolean;
  busy: boolean;
}): PushState {
  if (!input.supported) return "unsupported";
  if (input.busy) return "busy";
  if (input.permission === "denied") return "denied";
  return input.subscribed ? "on" : "off";
}

type PushCapableNavigator = Navigator & { serviceWorker: ServiceWorkerContainer };

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * The active registration, or null.
 *
 * `navigator.serviceWorker.ready` NEVER RESOLVES when nothing is registered — in development, where
 * `PwaInstallPrompt` deliberately does not register, awaiting it would hang this component's effect
 * forever. `getRegistration()` answers either way.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const nav = navigator as PushCapableNavigator;
  const existing = await nav.serviceWorker.getRegistration();
  if (existing === undefined) return null;
  return nav.serviceWorker.ready;
}

export function PushSubscribe({ enabled, vapidPublicKey }: PushSubscribeProps): React.JSX.Element | null {
  const controlId = useId();
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<"default" | "granted" | "denied">("default");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled || !isSupported()) return;
    setSupported(true);
    setPermission(Notification.permission);
    let cancelled = false;
    void (async () => {
      try {
        const registration = await activeRegistration();
        const existing = registration === null ? null : await registration.pushManager.getSubscription();
        if (!cancelled) setSubscribed(existing !== null);
      } catch {
        if (!cancelled) setSubscribed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const turnOn = useCallback(async () => {
    if (vapidPublicKey === null) return;
    const registration = await activeRegistration();
    if (registration === null) {
      toast.error("Install the app first — notifications need its background worker.");
      return;
    }
    // The tap IS the user gesture this call needs.
    const granted = await Notification.requestPermission();
    setPermission(granted);
    if (granted !== "granted") {
      if (granted === "denied") toast.error("Notifications are blocked for this site in your browser settings.");
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      // Required by every browser: a push that shows nothing is a push that can be used to track.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
    });
    const json = subscription.toJSON();
    const response = await fetch(PUSH_SUBSCRIBE_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    if (!response.ok) {
      // Registering with the browser but not with the desk would leave a subscription nothing ever
      // sends to. Undo it, so the switch and the truth agree.
      await subscription.unsubscribe().catch(() => undefined);
      throw new Error(`subscribe failed: ${response.status}`);
    }
    setSubscribed(true);
    toast.success("Notifications on for this device.");
  }, [vapidPublicKey]);

  const turnOff = useCallback(async () => {
    const registration = await activeRegistration();
    const subscription = registration === null ? null : await registration.pushManager.getSubscription();
    if (subscription !== null) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe().catch(() => undefined);
      await fetch(PUSH_SUBSCRIBE_PATH, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
    }
    setSubscribed(false);
    toast.success("Notifications off for this device.");
  }, []);

  const onToggle = useCallback(
    (next: boolean) => {
      setBusy(true);
      void (next ? turnOn() : turnOff())
        .catch(() => {
          toast.error("Could not change notifications for this device.");
        })
        .finally(() => setBusy(false));
    },
    [turnOn, turnOff],
  );

  if (!enabled || vapidPublicKey === null) return null;

  const state = pushState({ supported, permission, subscribed, busy });
  if (state === "unsupported") return null;

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={controlId} className="text-base font-medium md:text-sm">
          Notifications on this device
        </Label>
        <p className="mt-0.5 text-base text-muted-foreground md:text-sm">
          {state === "denied"
            ? "Blocked in your browser settings for this site. Allow notifications there, then come back."
            : "A ticket number and what happened — never a subject or anything a client wrote."}
        </p>
      </div>
      <Switch
        id={controlId}
        checked={state === "on"}
        disabled={state === "denied" || state === "busy"}
        onCheckedChange={onToggle}
        aria-label="Notifications on this device"
      />
    </div>
  );
}
