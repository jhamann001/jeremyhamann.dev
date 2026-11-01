/**
 * The pinned push transport.
 *
 * NO TEST HERE OPENS A SOCKET. `pushPinnedLookup` is driven directly with a stubbed resolver, and the
 * only `pushHttpsTransport` case exercised is the one that is refused BEFORE anything is scheduled —
 * a URL `node:https` will not accept. Everything past that point is proven at the `sendWebPush` seam
 * with an injected transport (`send.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type { LookupAddress } from "node:dns";
import type { PushAddressLookup } from "@/lib/web-push/endpoint";
import {
  PushAddressBlockedError,
  pushHttpsTransport,
  pushPinnedLookup,
  pushTransportFailure,
} from "@/lib/web-push/transport";

const publicAnswers: PushAddressLookup = async () => [{ address: "142.250.72.106" }];

function call(
  resolve: PushAddressLookup,
  all: boolean,
): Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }> {
  return new Promise((done) => {
    pushPinnedLookup(resolve)("fcm.googleapis.com", { all }, (err, address, family) =>
      done({ err, address, family }),
    );
  });
}

describe("pushPinnedLookup", () => {
  it("passes every answer through when all of them are public, with all: true", async () => {
    const { err, address } = await call(async () => [{ address: "142.250.72.106" }, { address: "2607:f8b0::200e" }], true);
    expect(err).toBeNull();
    expect(address).toEqual([
      { address: "142.250.72.106", family: 4 },
      { address: "2607:f8b0::200e", family: 6 },
    ]);
  });

  it("answers the first address and its family with all: false", async () => {
    const { err, address, family } = await call(publicAnswers, false);
    expect(err).toBeNull();
    expect(address).toBe("142.250.72.106");
    expect(family).toBe(4);
  });

  /**
   * THE REBIND. One public answer and one private answer is a rebind with the rebind pre-published,
   * and happy-eyeballs may take either — so the whole set is refused, exactly as
   * `assertResolvedAddresses` refuses it a moment earlier.
   */
  it("refuses the whole set when ANY answer is forbidden", async () => {
    for (const bad of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1"]) {
      const { err } = await call(async () => [{ address: "142.250.72.106" }, { address: bad }], true);
      expect(err).toBeInstanceOf(PushAddressBlockedError);
    }
  });

  it("refuses an empty answer — nothing to check is not the same as nothing wrong", async () => {
    const { err } = await call(async () => [], true);
    expect(err).toBeInstanceOf(PushAddressBlockedError);
  });

  it("passes a resolver failure through as an error — 'could not check' is not 'safe'", async () => {
    const { err } = await call(async () => {
      throw new Error("ENOTFOUND");
    }, false);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PushAddressBlockedError);
  });

  it("never names the blocked address in the error it raises", async () => {
    const { err } = await call(async () => [{ address: "169.254.169.254" }], true);
    expect(err?.message).not.toContain("169.254.169.254");
    expect(err?.message).toContain("fcm.googleapis.com");
  });
});

describe("pushTransportFailure", () => {
  it("names the timeout, the blocked connect and everything else, and quotes no third-party text", () => {
    expect(pushTransportFailure(new Error("whatever"), true)).toBe("timed out");
    expect(pushTransportFailure(new PushAddressBlockedError("fcm.googleapis.com"), false)).toContain(
      "at connect time",
    );
    expect(pushTransportFailure(new PushAddressBlockedError("fcm.googleapis.com"), false)).not.toContain(
      "fcm.googleapis.com",
    );
    // The error's NAME, never its message: a message can carry a URL or a provider's prose.
    expect(pushTransportFailure(new TypeError("https://fcm.googleapis.com/fcm/send/abc123 refused"), false)).toBe(
      "request failed (TypeError)",
    );
  });
});

describe("pushHttpsTransport", () => {
  it("refuses a non-https URL without scheduling anything", async () => {
    const result = await pushHttpsTransport({
      url: "http://fcm.googleapis.com/fcm/send/abc123",
      body: new Uint8Array([1, 2, 3]),
      headers: {},
      timeoutMs: 1_000,
      lookup: pushPinnedLookup(publicAnswers),
    });
    expect(result.status).toBeNull();
    expect(result).toMatchObject({ error: expect.stringContaining("request failed") });
  });
});
