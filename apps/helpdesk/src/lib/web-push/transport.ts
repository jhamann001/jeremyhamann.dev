/**
 * The socket a web-push message actually travels on (`pwa-push`) — CONTRACT §10 B10.
 *
 * NOTHING ON THIS BRANCH TRANSMITS. The three `VAPID_*` keys are unset in every environment, so
 * `sendWebPush` returns `"disabled"` and this module is never even imported at runtime: `send.ts`
 * loads it at the call, on the send path only (CONTRACT §0 rule 4).
 *
 * THE ADDRESS THAT IS CHECKED IS THE ADDRESS THAT IS USED.
 *
 * `assertPushEndpointResolvable` resolves the endpoint's hostname and judges every answer, and that
 * check used to be the whole control — but `fetch` then resolved the name a SECOND time,
 * independently, and nothing pinned the connection to what had been verified. Whoever controls DNS for
 * a name under one of the allowlisted push services (or a hostile or split-horizon resolver, which
 * `endpoint.ts` already names as the scenario the guard exists for) publishes a short-TTL record that
 * answers public for the guard's lookup and `10.0.0.5` — or `169.254.169.254` — for the connection's,
 * and the rebinding window the send's header claimed to close was wide open. No redirect is involved,
 * so `redirect: "error"` never came into it.
 *
 * So the connection carries its own resolver. `pushPinnedLookup` runs `isForbiddenAddress` over EVERY
 * answer at the moment the socket is about to be opened and fails the connect if any of them is
 * forbidden — the same all-or-nothing rule `assertResolvedAddresses` applies, because a name with one
 * public and one private answer is a rebind with the rebind pre-published, and happy-eyeballs may take
 * either. A resolver error stays an error: "we could not check" is not "it is safe".
 *
 * This is the shape `src/jobs/webhook-dispatch.ts` arrived at for the same defect, deliberately
 * mirrored rather than imported: that module is a job that pulls Prisma, the audit ledger and the
 * signing keys into its graph, and `send.ts` must stay loadable without any of them. The RULE the two
 * share — which addresses are forbidden — lives in one place, `@/lib/ssrf-guard`; only the twenty
 * lines of socket glue are stated twice. the build record asks for the
 * glue to be lifted into `@/lib/ssrf-guard` (B5's file) so even that is shared.
 *
 * REDIRECTS ARE NOT FOLLOWED — `node:https` does not follow them at all, which is the property
 * `redirect: "error"` used to buy: a 302 to `http://169.254.169.254` would otherwise be requested with
 * none of this guarding. A 3xx comes back as an ordinary non-2xx status, which `outcomeForStatus`
 * already maps to `"failed"`, exactly as the thrown redirect error did.
 *
 * THE RESPONSE BODY IS NEVER READ. A push service's body can echo the endpoint, which is a bearer
 * capability (CONTRACT §3.3 rule 2). The stream is drained so the socket closes cleanly, and only the
 * status travels back.
 */
import type { LookupAddress, LookupOptions } from "node:dns";
import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isForbiddenAddress, parseIpv4 } from "@/lib/ssrf-guard";
import { resolvePushAddresses, type PushAddressLookup } from "./endpoint";

/** The `lookup` a socket accepts. Deliberately the shape `node:net` declares, so it drops in. */
export type PushPinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/** The error a blocked connect fails with. Named so the send's log can say what happened. */
export class PushAddressBlockedError extends Error {
  constructor(hostname: string) {
    super(`Refusing to connect: ${hostname} resolves to an address this desk may not reach.`);
    this.name = "PushAddressBlockedError";
  }
}

/**
 * The address family `node:net` needs alongside each answer. `PushAddressLookup` is the promise-based
 * shape the guard already uses, and it is the ADDRESS that is judged; the family is arithmetic over
 * the same string, so the two halves cannot disagree about what was resolved.
 */
function familyOf(address: string): number {
  return parseIpv4(address) !== null ? 4 : 6;
}

/**
 * The socket's own resolver, built over the same `PushAddressLookup` the send-time guard used — one
 * injected resolver drives both halves, so a test cannot accidentally prove the guard against one
 * answer and the connection against another.
 */
export function pushPinnedLookup(resolve: PushAddressLookup = resolvePushAddresses): PushPinnedLookup {
  return (hostname, options, callback) => {
    void resolve(hostname).then(
      (answers) => {
        const addresses: LookupAddress[] = answers.map((a) => ({ address: a.address, family: familyOf(a.address) }));
        if (addresses.length === 0 || addresses.some((a) => isForbiddenAddress(a.address))) {
          callback(new PushAddressBlockedError(hostname), []);
          return;
        }
        if (options.all === true) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      },
      (e: unknown) => {
        callback(e instanceof Error ? e : new Error("That push service's name could not be resolved."), []);
      },
    );
  };
}

/** One attempt, exactly as the send builds it. `lookup` travels WITH the request, by design. */
export type PushRequest = {
  url: string;
  body: Uint8Array;
  headers: Record<string, string>;
  timeoutMs: number;
  /** The pinned resolver: the address that was checked is the address that is connected to. */
  lookup: PushPinnedLookup;
};

/** A response status, or a reason there was none. Never a response body: it is a third party's text. */
export type PushTransportResult = { status: number } | { status: null; error: string };

export type PushTransport = (request: PushRequest) => Promise<PushTransportResult>;

/** The reason one failed attempt logs. Never a response body, never the endpoint. */
export function pushTransportFailure(e: unknown, timedOut: boolean): string {
  if (timedOut) return "timed out";
  if (e instanceof PushAddressBlockedError) {
    return "that push service resolved to a private, loopback or link-local address at connect time";
  }
  const name = e instanceof Error ? e.name : typeof e;
  return `request failed (${name})`;
}

/**
 * The only code in this slice that opens a socket, and the reason it is `node:https` rather than
 * `fetch`: `fetch` gives no way to pin the connection to the address the guard verified (see the
 * header). A fresh agent per attempt, because a pooled socket was resolved and verified for an earlier
 * send and reusing it would reuse that verdict too.
 */
export const pushHttpsTransport: PushTransport = (request) =>
  new Promise<PushTransportResult>((resolve) => {
    const body = Buffer.from(request.body);
    let settled = false;
    let timedOut = false;

    let req: ClientRequest;
    try {
      req = httpsRequest(request.url, {
        method: "POST",
        headers: { ...request.headers, "Content-Length": String(body.byteLength) },
        lookup: request.lookup,
        agent: false,
      });
    } catch (e) {
      // Nothing has been scheduled yet — a malformed or non-https URL never reaches a socket.
      resolve({ status: null, error: pushTransportFailure(e, false) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
    }, request.timeoutMs);

    const done = (result: PushTransportResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // The status, the moment it is known. A connection destroyed AFTER the status line is still an
    // answer from the push service — and a 410 read that way is what prunes a dead subscription.
    let seenStatus: number | null = null;

    req.on("response", (res) => {
      seenStatus = res.statusCode ?? 0;
      res.resume();
      res.on("end", () => done({ status: seenStatus ?? 0 }));
    });
    req.on("error", (e) => done({ status: null, error: pushTransportFailure(e, timedOut) }));
    // Belt and braces: `close` always fires, so one attempt can never leave the caller awaiting a
    // promise that nothing will settle.
    req.on("close", () =>
      done(
        seenStatus === null
          ? { status: null, error: pushTransportFailure(new Error("connection closed"), timedOut) }
          : { status: seenStatus },
      ),
    );
    req.end(body);
  });
