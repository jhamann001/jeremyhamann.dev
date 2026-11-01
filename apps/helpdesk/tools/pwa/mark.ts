/**
 * The WM Help Desk app mark, as geometry (`pwa-push`).
 *
 * ONE definition, two renderings. `markShapes()` returns the drawing as a list of primitives in a
 * 512-unit square; `markSvg()` prints those primitives as SVG (committed as `public/icons/icon.svg`,
 * which is the mark's source of truth for a designer) and `renderMark()` rasterises the SAME list to
 * RGBA for the PNG encoder. There is no SVG parser and no image library anywhere in this toolchain
 * (CONTRACT §0: no new dependencies), so a hand-written rasteriser over three primitives is the whole
 * of it — and because both outputs come from one array, the SVG and the PNGs cannot drift apart.
 *
 * The primitives are chosen to be expressible exactly in both worlds:
 *   roundedRect → <rect rx>            · inside-test on the four corner arcs
 *   polygon     → <path d="M…L…Z">     · even-odd ray cast
 *   segment     → <path stroke-linecap="round">, which for a constant-width, round-joined polyline
 *                 is exactly the union of round-capped segments — so a two-segment check mark is two
 *                 `segment`s here and one `<path>` there, pixel-identical.
 *
 * The drawing: a dark rounded tile, a white speech bubble with a tail, and a knocked-out check — a
 * desk that answers, and an answer that is finished. Colours are the app's own neutral tokens
 * (`--background` / `--foreground` in `src/app/globals.css`) resolved to sRGB hex, because a manifest
 * and a PNG take hex and neither takes `oklch()`.
 */
import type { Rgba } from "./png";

/** The dark tile / knockout colour — `oklch(0.145 0 0)` rounded to sRGB, the dark-mode `--background`. */
export const INK = "#0a0a0a" as const;
/** The bubble — the light-mode `--background`. */
export const PAPER = "#ffffff" as const;

/** The coordinate system every shape below is written in. */
export const VIEW = 512 as const;

export type Shape =
  | { kind: "roundedRect"; x: number; y: number; w: number; h: number; r: number; fill: string }
  | { kind: "polygon"; points: ReadonlyArray<readonly [number, number]>; fill: string }
  | { kind: "segments"; points: ReadonlyArray<readonly [number, number]>; width: number; fill: string };

/**
 * `"rounded"` is the ordinary icon: a tile with rounded corners on a transparent field, which is what
 * a launcher that does NOT mask expects. `"full"` is the maskable / Apple variant: the tile bleeds to
 * every edge and the artwork shrinks into the safe zone, because a masking launcher will crop.
 */
export type MarkVariant = "rounded" | "full";

/** W3C maskable icons reserve the central 80% circle; artwork outside it may be cropped away. */
const SAFE_ZONE_SCALE = 0.8;

/** Scales a point about the centre of the view. */
function shrink(p: readonly [number, number], scale: number): readonly [number, number] {
  const c = VIEW / 2;
  return [c + (p[0] - c) * scale, c + (p[1] - c) * scale];
}

function scaleShape(s: Shape, scale: number): Shape {
  const c = VIEW / 2;
  switch (s.kind) {
    case "roundedRect":
      return {
        ...s,
        x: c + (s.x - c) * scale,
        y: c + (s.y - c) * scale,
        w: s.w * scale,
        h: s.h * scale,
        r: s.r * scale,
      };
    case "polygon":
      return { ...s, points: s.points.map((p) => shrink(p, scale)) };
    case "segments":
      return { ...s, points: s.points.map((p) => shrink(p, scale)), width: s.width * scale };
  }
}

/** The artwork, painted back to front. `variant` changes only the tile and the artwork's scale. */
export function markShapes(variant: MarkVariant): Shape[] {
  const tile: Shape = {
    kind: "roundedRect",
    x: 0,
    y: 0,
    w: VIEW,
    h: VIEW,
    // A maskable tile must reach the corners: the launcher, not us, decides the silhouette.
    r: variant === "rounded" ? 114 : 0,
    fill: INK,
  };
  const art: Shape[] = [
    { kind: "polygon", points: [[186, 300], [278, 300], [194, 434]], fill: PAPER },
    { kind: "roundedRect", x: 88, y: 112, w: 336, h: 240, r: 64, fill: PAPER },
    { kind: "segments", points: [[176, 232], [230, 286], [338, 178]], width: 36, fill: INK },
  ];
  const scale = variant === "rounded" ? 1 : SAFE_ZONE_SCALE;
  return [tile, ...art.map((s) => scaleShape(s, scale))];
}

// ---------------------------------------------------------------------------
// Inside tests — pure geometry, shared by the rasteriser and its unit test.
// ---------------------------------------------------------------------------

function insideRoundedRect(px: number, py: number, s: Extract<Shape, { kind: "roundedRect" }>): boolean {
  const { x, y, w, h, r } = s;
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const rr = Math.min(r, w / 2, h / 2);
  if (rr <= 0) return true;
  // Inside the cross formed by the two inset rectangles, or inside one of the four corner discs.
  if (px >= x + rr && px <= x + w - rr) return true;
  if (py >= y + rr && py <= y + h - rr) return true;
  const cx = px < x + rr ? x + rr : x + w - rr;
  const cy = py < y + rr ? y + rr : y + h - rr;
  return (px - cx) ** 2 + (py - cy) ** 2 <= rr * rr;
}

function insidePolygon(px: number, py: number, points: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const straddles = yi > py !== yj > py;
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px: number, py: number, a: readonly [number, number], b: readonly [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / len2));
  const dx = px - (a[0] + t * vx);
  const dy = py - (a[1] + t * vy);
  return Math.hypot(dx, dy);
}

/** True when the point is covered by `shape`. Exported for the geometry test. */
export function isInside(px: number, py: number, shape: Shape): boolean {
  switch (shape.kind) {
    case "roundedRect":
      return insideRoundedRect(px, py, shape);
    case "polygon":
      return insidePolygon(px, py, shape.points);
    case "segments": {
      const half = shape.width / 2;
      for (let i = 0; i + 1 < shape.points.length; i++) {
        if (distanceToSegment(px, py, shape.points[i], shape.points[i + 1]) <= half) return true;
      }
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Rasteriser
// ---------------------------------------------------------------------------

/** Samples per pixel per axis. 4×4 = 16 coverage samples: enough for flat art, cheap at 512². */
const SUPERSAMPLE = 4;

function parseHex(hex: string): readonly [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (m === null) throw new Error(`parseHex: expected #rrggbb, got "${hex}"`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Draws the mark at `size`×`size` as non-premultiplied RGBA8.
 *
 * Each shape is rasterised with its own supersampled coverage and composited with source-over. The
 * artwork is painted back to front and the only overlap between two DIFFERENT colours is the check
 * over the bubble, so per-shape antialiasing produces no seams that a single global sample would not
 * also produce.
 */
export function renderMark(size: number, variant: MarkVariant): Rgba {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`renderMark: bad size ${size}`);
  const shapes = markShapes(variant);
  const data = new Uint8Array(size * size * 4);
  const unit = VIEW / size;
  const step = unit / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (const shape of shapes) {
    const [sr, sg, sb] = parseHex(shape.fill);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let hits = 0;
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          const wy = (py + 0) * unit + (sy + 0.5) * step;
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const wx = (px + 0) * unit + (sx + 0.5) * step;
            if (isInside(wx, wy, shape)) hits++;
          }
        }
        if (hits === 0) continue;
        const alpha = hits / samples;
        const o = (py * size + px) * 4;
        const da = data[o + 3] / 255;
        const outA = alpha + da * (1 - alpha);
        if (outA <= 0) continue;
        for (let c = 0; c < 3; c++) {
          const src = c === 0 ? sr : c === 1 ? sg : sb;
          const dst = data[o + c];
          data[o + c] = Math.round((src * alpha + dst * da * (1 - alpha)) / outA);
        }
        data[o + 3] = Math.round(outA * 255);
      }
    }
  }
  return { width: size, height: size, data };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function shapeToSvg(s: Shape): string {
  switch (s.kind) {
    case "roundedRect":
      return `<rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${fmt(s.w)}" height="${fmt(s.h)}" rx="${fmt(s.r)}" fill="${s.fill}"/>`;
    case "polygon": {
      const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p[0])} ${fmt(p[1])}`).join(" ");
      return `<path d="${d} Z" fill="${s.fill}"/>`;
    }
    case "segments": {
      const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p[0])} ${fmt(p[1])}`).join(" ");
      return `<path d="${d}" fill="none" stroke="${s.fill}" stroke-width="${fmt(s.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  }
}

/** The mark as an SVG document. Written to `public/icons/icon.svg` — never served to a browser as an icon. */
export function markSvg(variant: MarkVariant): string {
  const body = markShapes(variant).map(shapeToSvg).join("\n  ");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" width="${VIEW}" height="${VIEW}" role="img" aria-label="WM Help Desk">`,
    `  <title>WM Help Desk</title>`,
    `  ${body}`,
    `</svg>`,
    "",
  ].join("\n");
}
