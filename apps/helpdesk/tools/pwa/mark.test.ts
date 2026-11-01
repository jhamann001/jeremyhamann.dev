/**
 * The app mark's geometry.
 *
 * One array of primitives feeds both the SVG and the rasteriser, so what has to be true is that the
 * primitives themselves are right and that both renderings come from the same array. The pixel
 * assertions below are sampled at points chosen from the drawing, not from a golden image: a golden
 * PNG in a test is a copy of the output, and it agrees with a wrong encoder exactly as readily.
 */
import { describe, expect, it } from "vitest";
import { INK, isInside, markShapes, markSvg, PAPER, renderMark, VIEW } from "./mark";

function pixel(image: ReturnType<typeof renderMark>, x: number, y: number): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

describe("mark geometry", () => {
  it("paints the tile first and the artwork over it", () => {
    const shapes = markShapes("rounded");
    expect(shapes[0].fill).toBe(INK);
    expect(shapes.map((s) => s.kind)).toEqual(["roundedRect", "polygon", "roundedRect", "segments"]);
  });

  it("rounds the tile for the ordinary icon and bleeds it for the maskable one", () => {
    const rounded = markShapes("rounded")[0];
    const full = markShapes("full")[0];
    expect(rounded.kind === "roundedRect" && rounded.r).toBeGreaterThan(0);
    expect(full.kind === "roundedRect" && full.r).toBe(0);
  });

  it("keeps every maskable point inside the 80% safe-zone circle", () => {
    const centre = VIEW / 2;
    const safeRadius = (VIEW * 0.8) / 2;
    const points: Array<readonly [number, number]> = [];
    for (const shape of markShapes("full").slice(1)) {
      if (shape.kind === "roundedRect") {
        points.push([shape.x, shape.y], [shape.x + shape.w, shape.y], [shape.x, shape.y + shape.h], [shape.x + shape.w, shape.y + shape.h]);
      } else {
        for (const p of shape.points) points.push(p);
      }
    }
    expect(points.length).toBeGreaterThan(0);
    for (const [x, y] of points) {
      expect(Math.hypot(x - centre, y - centre), `(${x},${y})`).toBeLessThanOrEqual(safeRadius);
    }
  });

  it("tests insideness for each primitive the way the renderings do", () => {
    const [tile, tail, bubble, check] = markShapes("rounded");
    // The rounded tile excludes its corner but includes its centre.
    expect(isInside(1, 1, tile)).toBe(false);
    expect(isInside(256, 256, tile)).toBe(true);
    // The bubble's own centre, and a point well outside it.
    expect(isInside(256, 232, bubble)).toBe(true);
    expect(isInside(20, 20, bubble)).toBe(false);
    // The tail's apex region, and the check's joint.
    expect(isInside(200, 310, tail)).toBe(true);
    expect(isInside(230, 286, check)).toBe(true);
    expect(isInside(256, 120, check)).toBe(false);
  });

  it("rasterises the tile, the bubble and the knocked-out check to the right colours", () => {
    const image = renderMark(512, "rounded");
    expect(image.width).toBe(512);
    expect(image.data).toHaveLength(512 * 512 * 4);
    // The very corner of a rounded tile is transparent; the centre of the tile is ink.
    expect(pixel(image, 0, 0)[3]).toBe(0);
    expect(pixel(image, 40, 256)).toEqual([10, 10, 10, 255]);
    // Inside the bubble, away from the check: paper.
    expect(pixel(image, 130, 150)).toEqual([255, 255, 255, 255]);
    // On the check stroke: ink again, over the paper.
    expect(pixel(image, 230, 286)).toEqual([10, 10, 10, 255]);
    expect(INK).toBe("#0a0a0a");
    expect(PAPER).toBe("#ffffff");
  });

  it("leaves no transparent pixel in the maskable variant", () => {
    const image = renderMark(64, "full");
    for (const corner of [
      [0, 0],
      [63, 0],
      [0, 63],
      [63, 63],
    ] as const) {
      expect(pixel(image, corner[0], corner[1])[3], `corner ${corner.join(",")}`).toBe(255);
    }
  });

  it("emits an SVG with one element per primitive and the same colours", () => {
    const svg = markSvg("rounded");
    expect(svg).toContain(`viewBox="0 0 ${VIEW} ${VIEW}"`);
    expect(svg).toContain("<title>WM Help Desk</title>");
    expect((svg.match(/<rect |<path /g) ?? [])).toHaveLength(markShapes("rounded").length);
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain(INK);
    expect(svg).toContain(PAPER);
    // No raster, no external reference, no script: it is geometry and nothing else.
    expect(svg).not.toMatch(/<image|<script|href=/);
  });

  it("is deterministic", () => {
    const a = renderMark(32, "rounded");
    const b = renderMark(32, "rounded");
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});
