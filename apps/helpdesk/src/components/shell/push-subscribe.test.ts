/**
 * The push opt-in's decisions.
 *
 * `urlBase64ToUint8Array` is the one piece of this component that fails SILENTLY when it is wrong:
 * a mis-converted application server key produces a subscription the push service will later refuse,
 * hours away from the code that made it. So it is round-tripped here against `Buffer`, which decodes
 * base64url independently of the `atob` path the browser takes.
 */
import { describe, expect, it } from "vitest";
import { PUSH_SUBSCRIBE_PATH, pushState, urlBase64ToUint8Array } from "@/components/shell/push-subscribe";

const VAPID_PUBLIC_KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

describe("urlBase64ToUint8Array", () => {
  it("decodes an application server key to its 65 raw bytes", () => {
    const bytes = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    expect(bytes).toHaveLength(65);
    // 0x04 = an uncompressed P-256 point, which is what a browser requires.
    expect(bytes[0]).toBe(0x04);
    expect(Array.from(bytes)).toEqual(Array.from(new Uint8Array(Buffer.from(VAPID_PUBLIC_KEY, "base64url"))));
  });

  it("handles every padding remainder", () => {
    for (let n = 1; n <= 8; n++) {
      const source = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 29 + 5) & 0xff));
      const text = Buffer.from(source).toString("base64url");
      expect(Array.from(urlBase64ToUint8Array(text)), `${n} bytes`).toEqual(Array.from(source));
    }
  });

  it("refuses anything that is not base64url rather than producing silent rubbish", () => {
    for (const bad of ["a+b/c", "abc=", "abc def", ""]) {
      expect(() => urlBase64ToUint8Array(bad), bad).toThrow(/base64url/);
    }
  });
});

describe("pushState", () => {
  const base = { supported: true, permission: "default" as const, subscribed: false, busy: false };

  it("renders nothing on a browser without push", () => {
    expect(pushState({ ...base, supported: false })).toBe("unsupported");
    // Even a browser that somehow reports a subscription is still "unsupported" if the APIs are gone.
    expect(pushState({ ...base, supported: false, subscribed: true })).toBe("unsupported");
  });

  it("says blocked rather than offering a switch that springs back", () => {
    expect(pushState({ ...base, permission: "denied" })).toBe("denied");
    expect(pushState({ ...base, permission: "denied", subscribed: true })).toBe("denied");
  });

  it("is off before an opt-in and on after one", () => {
    expect(pushState(base)).toBe("off");
    expect(pushState({ ...base, permission: "granted" })).toBe("off");
    expect(pushState({ ...base, permission: "granted", subscribed: true })).toBe("on");
  });

  it("is busy while a change is in flight, so the switch cannot be double-tapped", () => {
    expect(pushState({ ...base, busy: true })).toBe("busy");
    expect(pushState({ ...base, busy: true, permission: "granted", subscribed: true })).toBe("busy");
  });
});

describe("the route the component and the worker share", () => {
  it("is the one CONTRACT §8 names", () => {
    expect(PUSH_SUBSCRIBE_PATH).toBe("/api/push/subscribe");
  });
});
