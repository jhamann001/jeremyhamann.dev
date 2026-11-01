/**
 * The committed PWA artefacts: `public/manifest.webmanifest`, `public/icons/**`,
 * `public/offline.html`, and the root layout's declarations of them.
 *
 * These files are GENERATED but COMMITTED (`src/app/layout.tsx` says why: a build must not depend on
 * a generator having been run). A committed generated file drifts silently, so the first test here
 * re-runs the generator in memory and fails if what is on disk is not what it produces — the same
 * check `npm run pwa:icons -- --check` performs, in CI, without the CLI.
 *
 * The rest is the manifest contract a browser actually enforces: a declared icon that 404s makes an
 * app uninstallable, and nothing in the app would otherwise notice.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIcons, ICON_SPECS, ICONS_DIR, SVG_FILE } from "./generate-icons";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

function readPublic(rel: string): string {
  return readFileSync(path.join(PUBLIC_DIR, rel), "utf8");
}

/** Width and height straight out of IHDR, so a mislabelled `sizes` cannot pass. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = new Uint8Array(readFileSync(path.join(ICONS_DIR, file)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(Array.from(bytes.subarray(1, 4)), `${file} is not a PNG`).toEqual([0x50, 0x4e, 0x47]);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string };
type Manifest = {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
  shortcuts?: Array<{ name: string; url: string; icons?: ManifestIcon[] }>;
};

const manifest = JSON.parse(readPublic("manifest.webmanifest")) as Manifest;

describe("committed icon artefacts", () => {
  it("match what the generator produces, byte for byte", () => {
    for (const { file, bytes } of buildIcons()) {
      const target = path.join(ICONS_DIR, file);
      expect(existsSync(target), `public/icons/${file} is missing — run npm run pwa:icons`).toBe(true);
      const onDisk = new Uint8Array(readFileSync(target));
      expect(onDisk.length, `public/icons/${file} is stale — run npm run pwa:icons`).toBe(bytes.length);
      expect(Buffer.from(onDisk).equals(Buffer.from(bytes)), `public/icons/${file} is stale`).toBe(true);
    }
  });

  it("are PNGs of the dimensions their filenames claim", () => {
    for (const spec of ICON_SPECS) {
      expect(pngSize(spec.file), spec.file).toEqual({ width: spec.size, height: spec.size });
    }
    expect(existsSync(path.join(ICONS_DIR, SVG_FILE))).toBe(true);
  });
});

describe("manifest.webmanifest", () => {
  it("starts the installed app on the dashboard, in its own window, scoped to the origin", () => {
    expect(manifest.name).toBe("WM Help Desk");
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe("/dashboard");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    // `id` is the app's identity; it must not be the start URL, or moving the landing page would
    // register a second app beside the installed one.
    expect(manifest.id).toBe("/");
  });

  it("uses the design tokens' own colours", () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("declares both an any and a maskable icon at 192 and 512, and every file exists", () => {
    const any = manifest.icons.filter((i) => i.purpose === "any");
    const maskable = manifest.icons.filter((i) => i.purpose === "maskable");
    expect(any.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(maskable.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith("/icons/"), icon.src).toBe(true);
      const file = icon.src.slice("/icons/".length);
      expect(existsSync(path.join(ICONS_DIR, file)), `${icon.src} is declared but missing`).toBe(true);
      const size = pngSize(file);
      expect(`${size.width}x${size.height}`, icon.src).toBe(icon.sizes);
    }
  });

  it("only ever links to same-origin paths", () => {
    const urls = [
      manifest.start_url,
      manifest.scope,
      ...manifest.icons.map((i) => i.src),
      ...(manifest.shortcuts ?? []).flatMap((s) => [s.url, ...(s.icons ?? []).map((i) => i.src)]),
    ];
    for (const url of urls) expect(url.startsWith("/"), url).toBe(true);
  });

  it("is referenced by the root layout, along with the apple touch icon", () => {
    const layout = readFileSync(path.join(ROOT, "src", "app", "layout.tsx"), "utf8");
    expect(layout).toContain('manifest: "/manifest.webmanifest"');
    expect(layout).toContain("/icons/apple-touch-icon.png");
    expect(layout).toContain("/icons/icon-192.png");
    expect(layout).toContain("/icons/icon-512.png");
  });
});

describe("offline.html", () => {
  const offline = readPublic("offline.html");

  it("is entirely self-contained — no stylesheet, script, font or image request", () => {
    expect(offline).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
    expect(offline).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(offline).not.toMatch(/<img\b/i);
    expect(offline).not.toMatch(/https?:\/\//);
  });

  it("says what it is, and carries no record content", () => {
    expect(offline).toContain("<title>Offline — WM Help Desk</title>");
    expect(offline).toContain("You are offline");
    expect(offline).toMatch(/never stored on this device/i);
    // A cached static file is exactly where a ticket reference must never end up.
    expect(offline).not.toMatch(/HD-\d/);
    expect(offline).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    for (const needle of ["requester", "ticket #", "Ticket #"]) expect(offline, needle).not.toContain(needle);
  });

  it("meets the phone rules it cannot inherit from globals.css", () => {
    expect(offline).toContain("viewport-fit=cover");
    expect(offline).toContain("min-height: 44px");
    expect(offline).toContain("font-size: 16px");
    expect(offline).toContain("env(safe-area-inset-bottom");
    expect(offline).toContain("prefers-color-scheme: dark");
  });

  it("is never indexed", () => {
    expect(offline).toMatch(/name="robots"[^>]*noindex/);
  });
});
