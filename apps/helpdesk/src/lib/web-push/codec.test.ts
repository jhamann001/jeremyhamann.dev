/**
 * base64url strictness. These values arrive from a browser and become key material, so
 * "Buffer decoded something" is not the bar — canonical, unpadded, exact-length is.
 */
import { describe, expect, it } from "vitest";
import { ascii, concatBytes, fromBase64Url, isBase64Url, readUint32be, toBase64Url, uint32be } from "@/lib/web-push/codec";

describe("base64url codec", () => {
  it("round-trips arbitrary bytes without padding", () => {
    for (let n = 0; n <= 32; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const text = toBase64Url(bytes);
      expect(text).not.toContain("=");
      if (n > 0) expect(Array.from(fromBase64Url(text, n))).toEqual(Array.from(bytes));
    }
  });

  it("encodes the RFC 8291 auth secret to exactly 16 bytes", () => {
    expect(fromBase64Url("BTBZMqHH6r4Tts7J_aSIgg", 16)).toHaveLength(16);
  });

  it("refuses padding, standard-alphabet characters, whitespace and the empty string", () => {
    for (const bad of ["AAAA=", "a+b/c", " AAAA", "AAAA ", "", "A".repeat(5)]) {
      expect(isBase64Url(bad), bad).toBe(false);
      expect(() => fromBase64Url(bad), bad).toThrow();
    }
  });

  it("refuses a non-canonical encoding that Buffer would otherwise accept", () => {
    // "AB" and "AC" both decode to one byte under a permissive decoder; only one re-encodes to itself.
    const canonical = toBase64Url(Uint8Array.from([0x00]));
    const impostor = canonical === "AA" ? "AB" : "AA";
    expect(() => fromBase64Url(impostor)).toThrow(/canonical/);
  });

  it("refuses a value of the wrong decoded length, by length", () => {
    expect(() => fromBase64Url(toBase64Url(new Uint8Array(16)), 65)).toThrow(/expected 65 bytes, got 16/);
  });

  it("concatenates, writes and reads a big-endian uint32", () => {
    expect(Array.from(concatBytes(Uint8Array.from([1, 2]), new Uint8Array(0), Uint8Array.from([3])))).toEqual([1, 2, 3]);
    expect(Array.from(uint32be(4096))).toEqual([0x00, 0x00, 0x10, 0x00]);
    expect(readUint32be(uint32be(0xdeadbeef), 0)).toBe(0xdeadbeef);
    expect(() => uint32be(-1)).toThrow();
    expect(() => readUint32be(new Uint8Array(3), 0)).toThrow(/truncated/);
  });

  it("refuses a non-ASCII label", () => {
    expect(Array.from(ascii("ab"))).toEqual([97, 98]);
    expect(() => ascii("é")).toThrow(/ASCII/);
  });
});
