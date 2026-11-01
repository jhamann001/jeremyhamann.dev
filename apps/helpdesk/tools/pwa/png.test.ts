/**
 * The hand-written PNG encoder.
 *
 * There is no image library in this repo to check the output against (CONTRACT §0: no new
 * dependencies), so the test decodes the container itself: the signature, the chunk framing, the
 * CRC over every chunk, the IHDR fields, and — by inflating IDAT — the exact pixels back out. A
 * decoder written against the spec in the test file is a genuinely independent check of an encoder
 * written against the spec in the source file.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chunk, createImage, crc32, encodePng, PNG_SIGNATURE } from "./png";

type Chunk = { type: string; data: Uint8Array };

/** Walks the chunk list, verifying every length and every CRC on the way. */
function readChunks(png: Uint8Array): Chunk[] {
  expect(Array.from(png.subarray(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = view.getUint32(offset + 8 + length);
    expect(crc32(png.subarray(offset + 4, offset + 8 + length)), `CRC of ${type}`).toBe(stored);
    out.push({ type, data });
    offset += 12 + length;
  }
  expect(offset, "chunks must consume the file exactly").toBe(png.length);
  return out;
}

describe("PNG encoder", () => {
  it("agrees with the CRC-32 value RFC 2083 implies for a known string", () => {
    // The standard CRC-32 of "123456789" — the check value every CRC-32/ISO-HDLC implementation
    // publishes. If this is wrong every chunk in every icon is wrong.
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
  });

  it("writes signature, IHDR, IDAT and IEND, in that order and nothing else", () => {
    const png = encodePng(createImage(3, 2));
    expect(readChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("declares 8-bit RGBA, no interlace, at the requested size", () => {
    const [ihdr] = readChunks(encodePng(createImage(7, 5)));
    const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    expect(view.getUint32(0)).toBe(7);
    expect(view.getUint32(4)).toBe(5);
    expect(Array.from(ihdr.data.subarray(8))).toEqual([8, 6, 0, 0, 0]);
  });

  it("round-trips pixels: IDAT inflates to filter-0 scanlines of the original bytes", () => {
    const image = createImage(4, 3);
    for (let i = 0; i < image.data.length; i++) image.data[i] = (i * 17 + 3) & 0xff;
    const chunks = readChunks(encodePng(image));
    const idat = chunks.find((c) => c.type === "IDAT");
    expect(idat).toBeDefined();
    const raw = new Uint8Array(inflateSync(Buffer.from(idat!.data)));
    const stride = image.width * 4;
    expect(raw.length).toBe(image.height * (stride + 1));
    for (let y = 0; y < image.height; y++) {
      expect(raw[y * (stride + 1)], `filter byte of row ${y}`).toBe(0);
      expect(Array.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))).toEqual(
        Array.from(image.data.subarray(y * stride, (y + 1) * stride)),
      );
    }
  });

  it("is byte-deterministic for the same pixels", () => {
    const a = encodePng(createImage(16, 16));
    const b = encodePng(createImage(16, 16));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("refuses bad dimensions and mismatched data", () => {
    expect(() => createImage(0, 4)).toThrow();
    expect(() => createImage(4.5, 4)).toThrow();
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(/does not match/);
    expect(() => chunk("IHDRX", new Uint8Array(0))).toThrow(/four characters/);
  });
});
