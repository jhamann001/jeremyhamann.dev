/**
 * base64url and byte plumbing for the web-push stack (`pwa-push`).
 *
 * Every key, salt and secret that crosses the boundary between a browser, this server and a push
 * service travels as unpadded base64url (RFC 4648 §5) — `PushSubscription.toJSON()` produces it, the
 * VAPID keys are stored in it, and RFC 8291's test vectors are written in it. Node's Buffer decodes
 * "base64url", but it is permissive: it accepts padding, standard-alphabet characters and outright
 * rubbish, silently. These helpers are strict, because the values arriving here come from a browser
 * over the wire and are about to be used as cryptographic key material.
 *
 * No `node:crypto` here on purpose: this module is the one piece of the stack that is pure byte
 * manipulation, so it can be unit-tested and reasoned about on its own.
 */

/** Unpadded base64url, no whitespace, at least one character. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isBase64Url(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (!BASE64URL.test(text)) return false;
  // 4n+1 characters cannot come from any byte string.
  return text.length % 4 !== 1;
}

/** Bytes → unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Unpadded base64url → bytes. Throws on anything that is not strictly base64url, and on a value whose
 * decoded length is not what the caller expects.
 */
export function fromBase64Url(text: string, expectedBytes?: number): Uint8Array {
  if (!isBase64Url(text)) throw new Error("web-push: value is not unpadded base64url");
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  // Buffer is permissive enough that a string can round-trip to fewer bytes than its length implies;
  // re-encoding is the cheap way to prove the input was canonical.
  if (toBase64Url(bytes) !== text) throw new Error("web-push: value is not canonical base64url");
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new Error(`web-push: expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Concatenates byte runs into one buffer. */
export function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** ASCII (the only alphabet any of these labels uses) → bytes. */
export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new Error("web-push: label is not ASCII");
    out[i] = code;
  }
  return out;
}

/** A 32-bit unsigned big-endian field, as RFC 8188's record size is written. */
export function uint32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`web-push: ${value} is not a uint32`);
  }
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** Reads a 32-bit unsigned big-endian field. */
export function readUint32be(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("web-push: truncated uint32");
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}
