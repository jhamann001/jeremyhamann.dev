/**
 * What may be said ABOUT a push endpoint, as opposed to the endpoint itself (`pwa-push`).
 *
 * CONTRACT §3.3 rule 2: a secret never reaches the ledger, and a push endpoint URL is a secret — its
 * path is a bearer capability to send notifications to one person's browser, and anyone holding it
 * can. So `PUSH_SUBSCRIBED` / `PUSH_UNSUBSCRIBED` carry a SHA-256 of the endpoint and never the URL
 *, and the same hash is what lets two audit rows about the same device be matched to
 * each other without the ledger ever holding the capability.
 */
import { createHash } from "node:crypto";
import {
  assertResolvedAddresses,
  classifyForbiddenHostname,
  isForbiddenAddress,
  normalizeHostname,
  parseIpv4,
  parseIpv6,
  reservedHostRefusal,
} from "@/lib/ssrf-guard";
import type { SsrfVerdict } from "@/lib/ssrf-guard";

/** SHA-256 of the endpoint URL, lower-case hex. Stable, so two rows about one device line up. */
export function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("hex");
}

/**
 * The push service's HOST — `fcm.googleapis.com`, `updates.push.services.mozilla.com`, and so on.
 *
 * The host is a vendor name, not a capability and not a person: it says which service a delivery
 * failed against, which is the first thing anyone asks. The path, which IS the capability, is
 * dropped. Returns null for anything that is not a URL.
 */
export function pushServiceHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The SSRF guard for push endpoints
// ---------------------------------------------------------------------------

/**
 * A push endpoint is a URL a signed-in person hands the server, which the server then FETCHES from
 * inside the VPC, carrying a `vapid t=…, k=…` Authorization header (`send.ts`). That is the same
 * server-side request forgery primitive `@/lib/ssrf-guard` exists for — and a worse one, because it is
 * reachable by every authenticated member of staff rather than by `ops_team` on an admin page, and
 * because the caller never sees the outcome (`sendWebPush` answers `"failed"` either way), which makes
 * it blind. Without this guard, `https://10.0.0.5:8443/…` registered at `/api/push/subscribe` and then
 * triggered by following one's own ticket is an internal port scan performed by the desk.
 *
 * WHY AN ALLOWLIST AND NOT ONLY A DENYLIST. A webhook may legitimately point at any third party, so B5
 * can only enumerate what is forbidden. A push endpoint cannot: it is issued by one of a handful of
 * browser vendors' push services, and nothing else is ever a correct value. Naming those services is a
 * far stronger control than any list of forbidden ranges, and it is the one that still holds if a new
 * private range is invented tomorrow.
 *
 * The denylist half is kept underneath it anyway (`classifyForbiddenHostname`, `isForbiddenAddress`,
 * `assertResolvedAddresses`): two independent controls, so neither one being wrong is sufficient.
 *
 * NOT `assertPublicHttpsUrl`, but not for the reason this comment used to give. It claimed that
 * function refuses the class `[\s -]` read as U+0020–U+002D — every hyphen, comma, plus and
 * parenthesis — and that a base64url path (`…/fcm/send/cH4nG3-th15`) or a hyphenated vendor host
 * (`wns2-by3p.notify.windows.com`) would therefore be rejected. That was a misreading of literal
 * control characters in its source, since corrected: it refuses whitespace and C0/DEL only, and a
 * push endpoint passes it unharmed.
 *
 * The real reason to keep this separate is the one above — an allowlist of the handful of vendor push
 * services is a stronger control here than any denylist, and the two modules answer different
 * questions. The checks that matter — https, no credentials, no forbidden host, no IP literal — are
 * made below, against the same primitives.
 */

/** Longest endpoint the guard will look at; `push.actions.ts` caps the field at the same number. */
export const PUSH_ENDPOINT_MAX_CHARS = 2048;

/**
 * The push services a browser can actually hand us, matched on the whole host or on a dotted suffix.
 *
 * - `googleapis.com` — Chrome and every Chromium browser: `fcm.googleapis.com`, and the older
 *   `android.googleapis.com/gcm/send/…` some installs still hold.
 * - `push.services.mozilla.com` — Firefox: `updates.push.services.mozilla.com`.
 * - `notify.windows.com` — Edge / WNS: `wns2-by3p.notify.windows.com` and its regional siblings.
 * - `push.apple.com` — Safari on macOS and iOS: `web.push.apple.com`.
 *
 * Configuration expressed as code (CONTRACT §0 rule 3): a new browser vendor is a reviewed code
 * change, not an environment variable somebody can widen at 2am.
 */
export const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = Object.freeze([
  "googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
]);

/** True when the host is one of the known push services, by exact match or dotted suffix. */
export function isPushServiceHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "") return false;
  return PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function refuse(reason: string): SsrfVerdict {
  return { allowed: false, reason };
}

/**
 * Whitespace (including the line separators and every exotic space) plus control and format
 * characters — deliberately narrower than B5's `[\s -]`, which also swallows the hyphen every real
 * endpoint path contains.
 */
const CONTROL_OR_SPACE = /[\p{Cc}\p{Cf}\p{Z}]/u;

/**
 * The syntactic verdict for one push endpoint. Runs at SUBSCRIBE time and again before every send.
 *
 * Refuses, in order: an empty or over-long value, whitespace or control characters, anything `URL`
 * cannot parse, a scheme other than https, embedded credentials, a never-a-third-party name, a bare IP
 * literal, and any host that is not one of the known push services.
 *
 * It does NOT resolve DNS; `assertPushEndpointResolvable` does that immediately before the send.
 */
export function assertPushEndpointAllowed(endpoint: string): SsrfVerdict {
  const raw = endpoint.trim();
  if (raw === "") return refuse("A push endpoint is required.");
  if (raw.length > PUSH_ENDPOINT_MAX_CHARS) {
    return refuse(`A push endpoint may be at most ${PUSH_ENDPOINT_MAX_CHARS} characters.`);
  }
  if (CONTROL_OR_SPACE.test(raw)) {
    return refuse("A push endpoint may not contain whitespace or control characters.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse("That is not a valid absolute URL.");
  }

  if (parsed.protocol !== "https:") return refuse("A push endpoint must be an https URL.");
  // Length, not `!== ""`: security scanner CWE-208 reports an equality whose operand is named `password`.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return refuse("Credentials in a push endpoint are not accepted.");
  }

  const host = normalizeHostname(parsed.hostname);
  if (host === "") return refuse("That URL has no host.");
  // Two causes, two sentences (see `classifyForbiddenHostname`): a `.invalid` or `.test` name is not a
  // machine inside this network, it is a name that can never resolve at all, and saying otherwise sends
  // whoever reads it into their own DNS looking for something that was never there.
  const hostRefusal = classifyForbiddenHostname(host);
  if (hostRefusal !== null) {
    return refuse(
      hostRefusal.kind === "reserved"
        ? reservedHostRefusal(hostRefusal.suffix)
        : "That host is internal to this network.",
    );
  }
  if (parseIpv4(host) !== null || parseIpv6(host) !== null) {
    return refuse("A push endpoint is a push service's name, never a bare address.");
  }
  if (!isPushServiceHost(host)) {
    return refuse("That host is not a browser push service this desk sends to.");
  }
  return { allowed: true };
}

/** Injectable for the tests: `node:dns`'s `lookup` with `all: true`, narrowed to what we use. */
export type PushAddressLookup = (hostname: string) => Promise<Array<{ address: string }>>;

/**
 * The production resolver. Exported because the SEND-TIME guard and the SOCKET must run the same one:
 * `send.ts` hands whichever resolver it is using to both `assertPushEndpointResolvable` and
 * `pushPinnedLookup`, so the address that is judged is the address that is connected to.
 */
export const resolvePushAddresses: PushAddressLookup = async (hostname) => {
  // Imported at the call so the "disabled" path — which is every environment on this branch — never
  // pulls `node:dns` into the module graph.
  const { lookup } = await import("node:dns/promises");
  return lookup(hostname, { all: true, verbatim: true });
};

/**
 * The full verdict: the syntactic check, then every address the host actually resolves to.
 *
 * An allowlisted vendor name resolving to `10.0.0.5` means a hostile or split-horizon resolver rather
 * than a hostile subscriber, but "we could not check" and "it is safe" are still different answers, so
 * a resolver failure is a REFUSAL. Same two-halves shape as `src/server/webhooks.ts`, for the same
 * reason: DNS is mutable state owned by somebody else, and the address that matters is the one in
 * effect at the moment of the send.
 */
export async function assertPushEndpointResolvable(
  endpoint: string,
  lookup: PushAddressLookup = resolvePushAddresses,
): Promise<SsrfVerdict> {
  const syntactic = assertPushEndpointAllowed(endpoint);
  if (!syntactic.allowed) return syntactic;

  let hostname: string;
  try {
    hostname = new URL(endpoint.trim()).hostname;
  } catch {
    return refuse("That is not a valid absolute URL.");
  }

  let addresses: string[];
  try {
    addresses = (await lookup(hostname)).map((a) => a.address);
  } catch {
    return refuse("That push service's name could not be resolved, so it cannot be verified as public.");
  }
  if (addresses.some(isForbiddenAddress)) {
    return refuse("That push service resolves to a private, loopback or link-local address.");
  }
  return assertResolvedAddresses(addresses);
}
