#!/usr/bin/env node
/**
 * Generate all raster icon assets FROM the single SVG source of truth: app/icon.svg.
 *
 * Next.js App Router file-based metadata wires these up automatically:
 *   - app/icon.svg        -> <link rel="icon" type="image/svg+xml"> (modern browsers)
 *   - app/favicon.ico     -> <link rel="icon" sizes="any"> (legacy tab icon, 16/32/48)
 *   - app/apple-icon.png  -> <link rel="apple-touch-icon"> (180x180)
 *   - app/icon-192.png / icon-512.png -> referenced by the PWA web manifest
 *
 * To change the mark: edit app/icon.svg, then run `node scripts/generate-icons.mjs`.
 * There is intentionally no hand-maintained duplicate artwork; everything below is
 * derived from the SVG so the mark is a one-file change.
 *
 * Requires `sharp` (present in the dependency tree). ICO is packed by hand because
 * sharp does not emit ICO; the container simply embeds PNG images, which every
 * modern browser reads.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const publicDir = join(root, "public");
const svg = readFileSync(join(appDir, "icon.svg"));

/** Render the SVG source to a square PNG buffer at the given pixel size. */
async function png(size) {
  return sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
}

/** Pack one or more PNG buffers into a single multi-resolution .ico container. */
function buildIco(entries /* [{size, buf}] */) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const bufs = [];
  entries.forEach((e, i) => {
    const b = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0); // width (0 => 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1); // height
    dir.writeUInt8(0, b + 2); // palette
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(e.buf.length, b + 8); // image size
    dir.writeUInt32LE(offset, b + 12); // image offset
    offset += e.buf.length;
    bufs.push(e.buf);
  });
  return Buffer.concat([header, dir, ...bufs]);
}

async function main() {
  // favicon.ico: legacy multi-resolution tab icon.
  const icoSizes = [16, 32, 48];
  const icoEntries = await Promise.all(
    icoSizes.map(async (size) => ({ size, buf: await png(size) }))
  );
  writeFileSync(join(appDir, "favicon.ico"), buildIco(icoEntries));

  // Apple touch icon: App Router serves app/apple-icon.png as <link rel="apple-touch-icon">.
  writeFileSync(join(appDir, "apple-icon.png"), await png(180));

  // PWA manifest icons: referenced by app/manifest.ts at root URLs, so they must be
  // static assets under public/ (files in app/ are not served except metadata files).
  await Promise.all(
    [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
    ].map(async ([name, size]) => writeFileSync(join(publicDir, name), await png(size)))
  );

  console.log(
    "Generated app/favicon.ico (16/32/48), app/apple-icon.png (180), public/icon-192.png, public/icon-512.png from app/icon.svg"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
