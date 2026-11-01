/**
 * Evidentiary request context from headers — pure, edge-safe, layer L1.
 *
 * The audited IP comes from the trusted-hop resolver only: never from body, params or cookies, never the
 * leftmost `x-forwarded-for` element, never a fabricated loopback. Unresolvable → the literal "unknown".
 * No `node:*` imports: this module is shared with edge code.
 */
import type { RequestContext } from "@/types/domain";

export const UNKNOWN_IP = "unknown" as const;

const USER_AGENT_MAX_CHARS = 512;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;

function isIPv4(s: string): boolean {
  return IPV4_PATTERN.test(s);
}

/** Counts the 16-bit groups in one side of an IPv6 literal; null when any segment is malformed. */
function ipv6GroupCount(part: string, allowEmbeddedIPv4: boolean): number | null {
  if (part === "") return 0;
  const segments = part.split(":");
  let count = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.includes(".")) {
      // An embedded IPv4 address is only valid as the final segment of the address.
      if (!allowEmbeddedIPv4 || i !== segments.length - 1 || !isIPv4(seg)) return null;
      count += 2;
    } else {
      if (!HEX_GROUP.test(seg)) return null;
      count += 1;
    }
  }
  return count;
}

function isIPv6(s: string): boolean {
  let addr = s;
  const zoneAt = addr.indexOf("%");
  if (zoneAt !== -1) {
    const zone = addr.slice(zoneAt + 1);
    if (!/^[0-9A-Za-z._-]+$/.test(zone)) return false;
    addr = addr.slice(0, zoneAt);
  }
  if (addr === "" || !/^[0-9A-Fa-f:.]+$/.test(addr)) return false;
  const halves = addr.split("::");
  if (halves.length > 2) return false;
  if (halves.length === 1) {
    return ipv6GroupCount(halves[0], true) === 8;
  }
  const head = ipv6GroupCount(halves[0], false);
  const tail = ipv6GroupCount(halves[1], true);
  if (head === null || tail === null) return false;
  // "::" stands for at least one zero group.
  return head + tail <= 7;
}

/**
 * Trims; strips `[...]` brackets and a `:port` suffix on IPv4 / bracketed IPv6 literals.
 * Returns null unless the remainder is a valid IPv4 or IPv6 literal.
 */
export function normalizeIpLiteral(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;

  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close === -1) return null;
    const inner = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return null;
    return isIPv6(inner) ? inner : null;
  }

  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/.exec(s);
  if (v4WithPort) {
    return isIPv4(v4WithPort[1]) ? v4WithPort[1] : null;
  }

  return isIPv6(s) ? s : null;
}

/**
 * hops >= 1: `x-forwarded-for` split on ",", trimmed; the element at `length - hops` is the address the
 * outermost trusted proxy appended. A list shorter than `hops`, or an invalid literal, yields "unknown".
 * hops === 0 (no proxy): `x-real-ip` when it is a valid literal, else "unknown".
 * Index 0 is never used as a fallback (an attacker controls the leftmost element).
 */
export function resolveClientIp(h: Headers, trustedProxyHops: number): string {
  const hops = Number.isInteger(trustedProxyHops) && trustedProxyHops >= 0 ? trustedProxyHops : -1;
  if (hops < 0) return UNKNOWN_IP;

  if (hops === 0) {
    const real = h.get("x-real-ip");
    if (real === null) return UNKNOWN_IP;
    return normalizeIpLiteral(real) ?? UNKNOWN_IP;
  }

  const forwarded = h.get("x-forwarded-for");
  if (forwarded === null) return UNKNOWN_IP;
  const list = forwarded.split(",").map((part) => part.trim());
  if (list.length < hops) return UNKNOWN_IP;
  return normalizeIpLiteral(list[list.length - hops]) ?? UNKNOWN_IP;
}

/** next-router-prefetch === "1" || purpose === "prefetch" || sec-purpose includes "prefetch". */
export function isPrefetchHeaders(h: Headers): boolean {
  const nextPrefetch = h.get("next-router-prefetch");
  if (nextPrefetch !== null && nextPrefetch.trim() === "1") return true;
  const purpose = h.get("purpose");
  if (purpose !== null && purpose.trim().toLowerCase() === "prefetch") return true;
  const secPurpose = h.get("sec-purpose");
  if (secPurpose !== null && secPurpose.toLowerCase().includes("prefetch")) return true;
  return false;
}

/** `x-request-id` when it matches /^[A-Za-z0-9._:-]{8,128}$/, else a fresh UUID minted once per request. */
export function extractRequestId(h: Headers): string {
  const given = h.get("x-request-id");
  if (given !== null && REQUEST_ID_PATTERN.test(given)) return given;
  return crypto.randomUUID();
}

/** Builds the per-request evidentiary context. `userAgent` is truncated to 512 chars (null when absent/empty). */
export function requestContextFromHeaders(h: Headers, trustedProxyHops: number): RequestContext {
  const rawUserAgent = h.get("user-agent");
  const userAgent =
    rawUserAgent === null || rawUserAgent.trim() === "" ? null : rawUserAgent.slice(0, USER_AGENT_MAX_CHARS);
  return {
    ipAddress: resolveClientIp(h, trustedProxyHops),
    userAgent,
    requestId: extractRequestId(h),
    isPrefetch: isPrefetchHeaders(h),
  };
}
