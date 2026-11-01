/**
 * RFC 8291 "Message Encryption for Web Push" over RFC 8188 `aes128gcm` (`pwa-push`).
 *
 * `node:crypto` only — CONTRACT §0 forbids a new dependency, and the two RFCs are a page of HKDF and
 * one AES-GCM record between them. The implementation is checked against RFC 8291 §5's published
 * vector in `ece.test.ts`, NOT against a live push service: a test that needs Google's servers to
 * pass is a test that proves the network, and nothing on this branch is permitted to transmit.
 *
 * What the browser gives us (`PushSubscription.toJSON().keys`):
 *   p256dh — the user agent's uncompressed P-256 public key, 65 bytes, base64url
 *   auth   — a 16-byte authentication secret, base64url
 *
 * The scheme, in the order it happens (RFC 8291 §3.1):
 *   1. a fresh ephemeral P-256 key pair for THIS message (never reused — reuse leaks the key stream)
 *   2. ecdh_secret = ECDH(as_private, ua_public)
 *   3. PRK_key = HMAC-SHA-256(auth_secret, ecdh_secret)
 *   4. IKM     = HKDF-Expand(PRK_key, "WebPush: info" || 0x00 || ua_public || as_public, 32)
 *   5. PRK     = HMAC-SHA-256(salt, IKM)
 *   6. CEK     = HKDF-Expand(PRK, "Content-Encoding: aes128gcm" || 0x00, 16)
 *      NONCE   = HKDF-Expand(PRK, "Content-Encoding: nonce"     || 0x00, 12)
 *   7. one AES-128-GCM record over `plaintext || 0x02`, framed by RFC 8188's header:
 *      salt(16) || rs(4, big-endian) || idlen(1) || keyid(= as_public, 65)
 *
 * The 0x02 byte is RFC 8188's LAST-record padding delimiter. This encoder emits exactly one record,
 * which is all a push message ever needs — 4 KB is the ceiling every push service enforces anyway,
 * and our payloads are a kind label and a WM number.
 */
import { createCipheriv, createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { ascii, concatBytes, fromBase64Url, readUint32be, toBase64Url, uint32be } from "./codec";

/** RFC 8188 record size. One record, so this is simply the ceiling on what we will send. */
export const RECORD_SIZE = 4096 as const;
/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
const PUBLIC_KEY_BYTES = 65;
/** RFC 8291 §3.1: the authentication secret is 16 octets. */
const AUTH_SECRET_BYTES = 16;
/** RFC 8188 §2.1: the salt is 16 octets. */
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const CURVE = "prime256v1";

/** HKDF-Expand (RFC 5869 §2.3) for the three lengths this scheme uses, all <= one HMAC block. */
function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (length > 32) throw new Error("web-push: hkdfExpand only covers a single HMAC block here");
  const t = createHmac("sha256", prk).update(concatBytes(info, Uint8Array.from([1]))).digest();
  return new Uint8Array(t.subarray(0, length));
}

/** HKDF-Extract (RFC 5869 §2.2). */
function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", salt).update(ikm).digest());
}

/** The four labels, each NUL-terminated exactly as the RFCs write them. */
const KEY_INFO_PREFIX = concatBytes(ascii("WebPush: info"), Uint8Array.from([0]));
const CEK_INFO = concatBytes(ascii("Content-Encoding: aes128gcm"), Uint8Array.from([0]));
const NONCE_INFO = concatBytes(ascii("Content-Encoding: nonce"), Uint8Array.from([0]));

export type ContentKeys = { cek: Uint8Array; nonce: Uint8Array };

/**
 * Steps 3–6, shared by the encoder and the decoder. Exported because the decoder is the strongest
 * check the encoder has: deriving the same two keys from the OTHER side of the ECDH is an
 * independent traversal of the same schedule.
 */
export function deriveContentKeys(input: {
  ecdhSecret: Uint8Array;
  authSecret: Uint8Array;
  uaPublicKey: Uint8Array;
  asPublicKey: Uint8Array;
  salt: Uint8Array;
}): ContentKeys {
  const prkKey = hkdfExtract(input.authSecret, input.ecdhSecret);
  const keyInfo = concatBytes(KEY_INFO_PREFIX, input.uaPublicKey, input.asPublicKey);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = hkdfExtract(input.salt, ikm);
  return { cek: hkdfExpand(prk, CEK_INFO, 16), nonce: hkdfExpand(prk, NONCE_INFO, 12) };
}

/** What `encryptPayload` returns: the complete `aes128gcm` body, plus its two public parameters. */
export type EncryptedPayload = {
  /** The whole RFC 8188 message — header AND record. This is the HTTP request body, verbatim. */
  body: Uint8Array;
  /** base64url of the 16-byte salt. Already inside `body`; returned so a caller can assert on it. */
  salt: string;
  /** base64url of the ephemeral sender public key (the header's `keyid`). Same note as `salt`. */
  publicKey: string;
};

/** Deterministic inputs, for the RFC vector and for nothing else. Production always randomises both. */
export type EncryptOptions = {
  salt?: Uint8Array;
  senderPrivateKey?: Uint8Array;
};

/**
 * Encrypts one push message. `p256dh` and `auth` are the browser's two subscription keys, base64url.
 *
 * Deterministic variant: `encryptPayloadWith` takes the salt and the ephemeral private key so the RFC
 * 8291 §5 vector can be reproduced byte for byte. `encryptPayload` — the CONTRACT §10 signature — is
 * that function with fresh randomness, which is the only thing production may ever use.
 */
export function encryptPayloadWith(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  options: EncryptOptions = {},
): EncryptedPayload {
  const uaPublicKey = fromBase64Url(p256dh, PUBLIC_KEY_BYTES);
  if (uaPublicKey[0] !== 0x04) throw new Error("web-push: p256dh is not an uncompressed P-256 point");
  const authSecret = fromBase64Url(auth, AUTH_SECRET_BYTES);

  const salt = options.salt ?? new Uint8Array(randomBytes(SALT_BYTES));
  if (salt.length !== SALT_BYTES) throw new Error("web-push: salt must be 16 bytes");

  // The record is `plaintext || 0x02` plus a 16-byte tag, and the whole record must fit `rs`.
  if (plaintext.length + 1 + TAG_BYTES > RECORD_SIZE) {
    throw new Error(`web-push: payload of ${plaintext.length} bytes exceeds one ${RECORD_SIZE}-byte record`);
  }

  const ecdh = createECDH(CURVE);
  if (options.senderPrivateKey === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(Buffer.from(options.senderPrivateKey));
  const asPublicKey = new Uint8Array(ecdh.getPublicKey());
  const ecdhSecret = new Uint8Array(ecdh.computeSecret(Buffer.from(uaPublicKey)));

  const { cek, nonce } = deriveContentKeys({ ecdhSecret, authSecret, uaPublicKey, asPublicKey, salt });

  // `{ authTagLength: 16 }` is the default for GCM, and it is written out because security scanner CWE-310
  // requires the expected tag length to be stated rather than inherited:
  // an unstated length is what lets a truncated tag be accepted. The literal 16 is `TAG_BYTES`, which
  // is also the number of bytes RFC 8291 §4 reserves per record and the length `decryptPayload`
  // slices back off — the scanner reads a literal, so it is spelled as one on both sides.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce, { authTagLength: 16 });
  const record = concatBytes(plaintext, Uint8Array.from([2]));
  const sealed = concatBytes(
    new Uint8Array(cipher.update(Buffer.from(record))),
    new Uint8Array(cipher.final()),
    new Uint8Array(cipher.getAuthTag()),
  );

  const header = concatBytes(salt, uint32be(RECORD_SIZE), Uint8Array.from([asPublicKey.length]), asPublicKey);
  return { body: concatBytes(header, sealed), salt: toBase64Url(salt), publicKey: toBase64Url(asPublicKey) };
}

/** CONTRACT §10 B10. Fresh salt, fresh ephemeral key pair, every single message. */
export function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
): { body: Uint8Array; salt: string; publicKey: string } {
  return encryptPayloadWith(plaintext, p256dh, auth, {});
}

/**
 * The inverse, from the USER AGENT's side: given the subscription's private key and auth secret,
 * recover the plaintext of an `aes128gcm` message.
 *
 * This exists for the tests — it is what lets `ece.test.ts` prove a round trip without a browser, and
 * it reaches the key schedule from the opposite direction, so an error in `deriveContentKeys` cannot
 * cancel itself out. Nothing in `src/server/**` calls it.
 */
export function decryptPayload(message: Uint8Array, uaPrivateKey: Uint8Array, auth: string): Uint8Array {
  if (message.length < SALT_BYTES + 4 + 1) throw new Error("web-push: message is shorter than its header");
  const salt = message.subarray(0, SALT_BYTES);
  const recordSize = readUint32be(message, SALT_BYTES);
  const idLength = message[SALT_BYTES + 4];
  const keyIdStart = SALT_BYTES + 5;
  const bodyStart = keyIdStart + idLength;
  if (idLength !== PUBLIC_KEY_BYTES || bodyStart > message.length) throw new Error("web-push: malformed header");
  const asPublicKey = new Uint8Array(message.subarray(keyIdStart, bodyStart));
  const sealed = new Uint8Array(message.subarray(bodyStart));
  if (sealed.length > recordSize) throw new Error("web-push: record longer than the declared record size");
  if (sealed.length < TAG_BYTES + 1) throw new Error("web-push: record is shorter than its tag");

  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(uaPrivateKey));
  const uaPublicKey = new Uint8Array(ecdh.getPublicKey());
  const ecdhSecret = new Uint8Array(ecdh.computeSecret(Buffer.from(asPublicKey)));
  const authSecret = fromBase64Url(auth, AUTH_SECRET_BYTES);
  const { cek, nonce } = deriveContentKeys({ ecdhSecret, authSecret, uaPublicKey, asPublicKey, salt: new Uint8Array(salt) });

  // Both directions state the tag length (see `encryptPayloadWith`). On the decrypt side it is the
  // load-bearing half: with it, a `setAuthTag` of any other length is rejected outright.
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce, { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.length - TAG_BYTES)));
  const padded = concatBytes(
    new Uint8Array(decipher.update(Buffer.from(sealed.subarray(0, sealed.length - TAG_BYTES)))),
    new Uint8Array(decipher.final()),
  );

  // Strip RFC 8188's padding delimiter (0x02 on the last record) and any zero padding after it.
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end === 0 || padded[end - 1] !== 2) throw new Error("web-push: missing last-record delimiter");
  return padded.subarray(0, end - 1);
}
