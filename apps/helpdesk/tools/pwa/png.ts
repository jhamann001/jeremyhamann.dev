/**
 * A minimal PNG encoder (`pwa-push`).
 *
 * WHY THIS EXISTS. The app icons have to be PNG — every manifest consumer, every `apple-touch-icon`
 * and the Badging API's fallback want raster — and CONTRACT §0 rule "no new npm dependencies" means
 * `sharp`, `pngjs`, `canvas` and `resvg` are all out. The PNG container is small enough to write
 * correctly: a signature, three chunks and a CRC. `node:zlib` supplies the only hard part (DEFLATE).
 *
 * SCOPE, deliberately narrow: 8-bit RGBA (colour type 6), no interlace, filter type 0 (None) on every
 * scanline. Flat vector art of two colours deflates to a few kilobytes even unfiltered, and a filter
 * chooser is the part of a PNG encoder that goes subtly wrong.
 *
 * This file writes no files and reads no environment. `generate-icons.ts` is the only caller.
 */
import { deflateSync } from "node:zlib";

/** PNG's eight-byte file signature (RFC 2083 §3.1). */
const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An RGBA8 image: `data.length === width * height * 4`, row-major, non-premultiplied. */
export type Rgba = { width: number; height: number; data: Uint8Array };

/** Allocates a fully transparent RGBA8 image. */
export function createImage(width: number, height: number): Rgba {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`createImage: bad dimensions ${width}x${height}`);
  }
  return { width, height, data: new Uint8Array(width * height * 4) };
}

// ---------------------------------------------------------------------------
// CRC-32 (RFC 2083 §15) — the table is built once, as the spec's own sample code does.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `bytes`, as PNG chunks carry it (over the type and the data, never the length). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

/** One PNG chunk: length, four-byte type, data, CRC over type+data. */
export function chunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error(`chunk: type must be four characters, got "${type}"`);
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

/**
 * Encodes an RGBA8 image as a PNG byte stream.
 *
 * The scanline prefix byte is the PNG filter type and is 0 (None) on every row: `deflateSync` at
 * level 9 already reduces these icons to a few kilobytes, and an unfiltered stream is one fewer thing
 * that can be wrong in a hand-written encoder.
 */
export function encodePng(image: Rgba): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error(`encodePng: data length ${data.length} does not match ${width}x${height}x4`);
  }

  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (per-scanline byte, always 0 here)
  ihdr[12] = 0; // interlace: none

  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** The signature, exported so a test can assert it rather than restate it. */
export const PNG_SIGNATURE: Uint8Array = SIGNATURE;
