/**
 * RFC 8291 message encryption, checked against the RFC's OWN published example.
 *
 * CONTRACT §10 B10 is explicit that this is tested against the vector and not against a live push
 * service, and the reason is worth restating: a test that needs a push service to pass proves the
 * network was up. This one proves the key schedule and the RFC 8188 framing, offline, deterministically.
 *
 * RFC 8291 §5 ("Push Message Encryption Example") fixes every input — the receiver's key pair and
 * auth secret, the sender's ephemeral key pair, and the salt — and publishes the resulting
 * `aes128gcm` message. Feeding those inputs in must reproduce that message byte for byte.
 *
 * Two further checks stand behind the literal, so a failure says WHICH half is wrong:
 *  - the ephemeral PUBLIC key derived from the RFC's private scalar equals the RFC's published one
 *    (if this fails, the ECDH plumbing is wrong, not the framing);
 *  - `decryptPayload` recovers the plaintext from the OTHER side of the ECDH, which traverses the
 *    same key schedule in the opposite direction.
 */
import { describe, expect, it } from "vitest";
import { decryptPayload, deriveContentKeys, encryptPayload, encryptPayloadWith, RECORD_SIZE } from "@/lib/web-push/ece";
import { fromBase64Url, toBase64Url } from "@/lib/web-push/codec";

/** Every value below is quoted from RFC 8291 §5. */
const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublicKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  asPublicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
} as const;

const plaintextBytes = new TextEncoder().encode(VECTOR.plaintext);

describe("RFC 8291 aes128gcm encryption", () => {
  it("derives the RFC's ephemeral public key from the RFC's ephemeral private key", () => {
    const out = encryptPayloadWith(plaintextBytes, VECTOR.uaPublicKey, VECTOR.authSecret, {
      salt: fromBase64Url(VECTOR.salt, 16),
      senderPrivateKey: fromBase64Url(VECTOR.asPrivateKey, 32),
    });
    expect(out.publicKey).toBe(VECTOR.asPublicKey);
    expect(out.salt).toBe(VECTOR.salt);
  });

  it("reproduces the RFC 8291 §5 message byte for byte", () => {
    const out = encryptPayloadWith(plaintextBytes, VECTOR.uaPublicKey, VECTOR.authSecret, {
      salt: fromBase64Url(VECTOR.salt, 16),
      senderPrivateKey: fromBase64Url(VECTOR.asPrivateKey, 32),
    });
    expect(toBase64Url(out.body)).toBe(VECTOR.message);
  });

  it("frames the header as salt(16) | rs(4) | idlen(1) | keyid(65)", () => {
    const body = fromBase64Url(VECTOR.message);
    expect(Array.from(body.subarray(0, 16))).toEqual(Array.from(fromBase64Url(VECTOR.salt, 16)));
    expect(Array.from(body.subarray(16, 20))).toEqual([0x00, 0x00, 0x10, 0x00]); // 4096
    expect(body[20]).toBe(65);
    expect(toBase64Url(body.subarray(21, 86))).toBe(VECTOR.asPublicKey);
    // header + plaintext + the 0x02 delimiter + the 16-byte GCM tag
    expect(body.length).toBe(86 + plaintextBytes.length + 1 + 16);
  });

  it("decrypts from the user agent's side, back to the plaintext", () => {
    const out = encryptPayloadWith(plaintextBytes, VECTOR.uaPublicKey, VECTOR.authSecret, {
      salt: fromBase64Url(VECTOR.salt, 16),
      senderPrivateKey: fromBase64Url(VECTOR.asPrivateKey, 32),
    });
    const recovered = decryptPayload(out.body, fromBase64Url(VECTOR.uaPrivateKey, 32), VECTOR.authSecret);
    expect(new TextDecoder().decode(recovered)).toBe(VECTOR.plaintext);
  });

  it("round-trips a real payload with a fresh salt and a fresh ephemeral key", () => {
    const payload = new TextEncoder().encode(JSON.stringify({ title: "WM Help Desk", body: "Assigned — HD-1042" }));
    const first = encryptPayload(payload, VECTOR.uaPublicKey, VECTOR.authSecret);
    const second = encryptPayload(payload, VECTOR.uaPublicKey, VECTOR.authSecret);
    // Never the same twice: reusing a salt or an ephemeral key across messages leaks the key stream.
    expect(toBase64Url(first.body)).not.toBe(toBase64Url(second.body));
    expect(first.salt).not.toBe(second.salt);
    expect(first.publicKey).not.toBe(second.publicKey);
    const recovered = decryptPayload(first.body, fromBase64Url(VECTOR.uaPrivateKey, 32), VECTOR.authSecret);
    expect(new TextDecoder().decode(recovered)).toBe(new TextDecoder().decode(payload));
  });

  it("refuses a payload that will not fit one record", () => {
    const tooBig = new Uint8Array(RECORD_SIZE);
    expect(() => encryptPayload(tooBig, VECTOR.uaPublicKey, VECTOR.authSecret)).toThrow(/exceeds one 4096-byte record/);
    // One byte under the ceiling is accepted, so the boundary is where it says it is.
    expect(() => encryptPayload(new Uint8Array(RECORD_SIZE - 17), VECTOR.uaPublicKey, VECTOR.authSecret)).not.toThrow();
  });

  it("refuses subscription keys of the wrong shape", () => {
    expect(() => encryptPayload(plaintextBytes, "not-base64url!", VECTOR.authSecret)).toThrow();
    expect(() => encryptPayload(plaintextBytes, VECTOR.uaPublicKey, "AAAA")).toThrow(/expected 16 bytes/);
    // A compressed point: 65 bytes but a leading 0x02/0x03 rather than 0x04.
    const compressed = fromBase64Url(VECTOR.uaPublicKey, 65).slice();
    compressed[0] = 0x03;
    expect(() => encryptPayload(plaintextBytes, toBase64Url(compressed), VECTOR.authSecret)).toThrow(/uncompressed/);
  });

  it("rejects a tampered ciphertext rather than returning wrong plaintext", () => {
    const body = fromBase64Url(VECTOR.message).slice();
    body[body.length - 1] ^= 0x01;
    expect(() => decryptPayload(body, fromBase64Url(VECTOR.uaPrivateKey, 32), VECTOR.authSecret)).toThrow();
  });

  it("refuses a malformed header", () => {
    const uaPrivate = fromBase64Url(VECTOR.uaPrivateKey, 32);
    expect(() => decryptPayload(new Uint8Array(4), uaPrivate, VECTOR.authSecret)).toThrow(/shorter than its header/);
    const badIdLen = fromBase64Url(VECTOR.message).slice();
    badIdLen[20] = 64;
    expect(() => decryptPayload(badIdLen, uaPrivate, VECTOR.authSecret)).toThrow(/malformed header/);
  });

  it("derives a different CEK for a different salt (the salt is load-bearing)", () => {
    const base = {
      ecdhSecret: new Uint8Array(32).fill(7),
      authSecret: fromBase64Url(VECTOR.authSecret, 16),
      uaPublicKey: fromBase64Url(VECTOR.uaPublicKey, 65),
      asPublicKey: fromBase64Url(VECTOR.asPublicKey, 65),
    };
    const a = deriveContentKeys({ ...base, salt: new Uint8Array(16).fill(1) });
    const b = deriveContentKeys({ ...base, salt: new Uint8Array(16).fill(2) });
    expect(a.cek).toHaveLength(16);
    expect(a.nonce).toHaveLength(12);
    expect(toBase64Url(a.cek)).not.toBe(toBase64Url(b.cek));
    expect(toBase64Url(a.nonce)).not.toBe(toBase64Url(b.nonce));
  });
});
