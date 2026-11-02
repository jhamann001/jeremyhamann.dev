import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = process.cwd();

const FONT_FILES = [
  {
    path: "app/fonts/Newsreader-Latin.woff2",
    bytes: 58_084,
    sha256: "62981321d9a3cc7a61a73792729043703fd6112da86e8ec848bb57f088578757",
    coverage: "À€",
  },
  {
    path: "app/fonts/Newsreader-LatinExt.woff2",
    bytes: 36_244,
    sha256: "ac6fa9ed533278f4c8fd3ae44a1fc78c7df736040237ab86fc1160d020af0af2",
    coverage: "ČŽ",
  },
  {
    path: "app/fonts/Newsreader-Vietnamese.woff2",
    bytes: 11_932,
    sha256: "f0dcc9795666850cc4cd8d50d55c44d48d9103cc86f552b4a12f0793eb915840",
    coverage: "ếự",
  },
  {
    path: "app/fonts/Heebo-Variable.woff2",
    bytes: 64_028,
    sha256: "e2b2967768cf022f6ee0f66551e355cc3dc6188fd76c0a33557efc9c97f27cf1",
    coverage: "ÀČŽעברית€",
  },
  {
    path: "app/fonts/IBMPlexMono-Regular.ttf",
    bytes: 135_580,
    sha256: "6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46",
    coverage: "ÀČŽКириллица€",
  },
  {
    path: "app/fonts/IBMPlexMono-SemiBold.ttf",
    bytes: 140_216,
    sha256: "d3c38e55c78f5b0f28009fddba4834ec503278936a5986032424c9bd2d23aa46",
    coverage: "ÀČŽКириллица€",
  },
] as const;

const FONT_GROUPS = [
  {
    variable: "--font-serif-latin",
    weights: ["400", "500", "600"],
    sourcePaths: Array(3).fill("./fonts/Newsreader-Latin.woff2") as string[],
    fallback: "Times New Roman",
    sample: "À€",
    unicodeRange: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
  {
    variable: "--font-serif-extended",
    weights: ["400", "500", "600"],
    sourcePaths: Array(3).fill("./fonts/Newsreader-LatinExt.woff2") as string[],
    fallback: false,
    preload: false,
    sample: "ČŽ",
    unicodeRange: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
  },
  {
    variable: "--font-serif-vietnamese",
    weights: ["400", "500", "600"],
    sourcePaths: Array(3).fill("./fonts/Newsreader-Vietnamese.woff2") as string[],
    fallback: false,
    preload: false,
    sample: "ếự",
    unicodeRange: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
  },
  {
    variable: "--font-sans",
    weights: ["400", "500", "600", "700"],
    sourcePaths: Array(4).fill("./fonts/Heebo-Variable.woff2") as string[],
    fallback: "Arial",
    sample: "ÀČŽעברית€",
  },
  {
    variable: "--font-mono",
    weights: ["400", "600"],
    sourcePaths: [
      "./fonts/IBMPlexMono-Regular.ttf",
      "./fonts/IBMPlexMono-SemiBold.ttf",
    ],
    fallback: "Arial",
    sample: "ÀČŽКириллица€",
  },
] as const;

type ParsedFont = {
  hasGlyphForCodePoint(codePoint: number): boolean;
};

type FontParser = (buffer: Buffer) => ParsedFont;

function resolveFontParser(moduleValue: unknown): FontParser {
  let candidate = moduleValue;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate === "function") return candidate as FontParser;
    if (candidate && typeof candidate === "object" && "default" in candidate) {
      candidate = (candidate as { default: unknown }).default;
      continue;
    }
    break;
  }
  throw new Error("Next's compiled font parser is unavailable");
}

function localFontBlock(
  layout: string,
  name: "serif" | "serifExtended" | "serifVietnamese" | "sans" | "mono",
) {
  const match = layout.match(new RegExp(`const ${name} = localFont\\(\\{([\\s\\S]*?)\\n\\}\\);`));
  expect(match, `${name} localFont declaration is missing`).not.toBeNull();
  return match![1];
}

function values(block: string, property: "path" | "weight") {
  return [...block.matchAll(new RegExp(`${property}:\\s*"([^"]+)"`, "g"))].map((match) => match[1]);
}

test("bundled font assets, declarations, coverage, and licenses stay pinned", () => {
  const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
  expect(layout).toContain('import localFont from "next/font/local"');
  expect(layout).not.toContain("next/font/google");

  const names = ["serif", "serifExtended", "serifVietnamese", "sans", "mono"] as const;
  for (const [index, name] of names.entries()) {
    const group = FONT_GROUPS[index];
    const block = localFontBlock(layout, name);
    expect(values(block, "path")).toEqual(group.sourcePaths);
    expect(values(block, "weight")).toEqual(group.weights);
    expect(block).toContain(`variable: "${group.variable}"`);
    expect(block).toContain('display: "swap"');
    expect(block).toContain(
      typeof group.fallback === "string"
        ? `adjustFontFallback: "${group.fallback}"`
        : "adjustFontFallback: false",
    );
    if ("preload" in group) expect(block).toContain("preload: false");
    if ("unicodeRange" in group) expect(block).toContain(group.unicodeRange);
    expect([...block.matchAll(/style:\s*"normal"/g)]).toHaveLength(group.weights.length);
  }
  expect(layout).toContain(
    '"--font-serif": "var(--font-serif-extended), var(--font-serif-vietnamese), var(--font-serif-latin)"',
  );

  const fontParser = resolveFontParser(
    createRequire(join(ROOT, "package.json"))("next/dist/compiled/@next/font/dist/fontkit"),
  );
  for (const asset of FONT_FILES) {
    const buffer = readFileSync(join(ROOT, asset.path));
    expect(buffer.byteLength, `${asset.path} size changed`).toBe(asset.bytes);
    expect(createHash("sha256").update(buffer).digest("hex"), `${asset.path} hash changed`).toBe(asset.sha256);

    const font = fontParser(buffer);
    for (const glyph of asset.coverage) {
      expect(
        font.hasGlyphForCodePoint(glyph.codePointAt(0)!),
        `${asset.path} lost representative glyph ${glyph}`,
      ).toBe(true);
    }
  }

  const notice = readFileSync(join(ROOT, "public/fonts/NOTICE.txt"), "utf8");
  expect(notice).toContain("AOA bundled fonts — original distribution files, no local conversion or subsetting");
  expect(notice).toContain("Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)");
  expect(notice).toContain("Copyright 2014 The Heebo Project Authors (https://github.com/OdedEzer/heebo)");
  expect(notice).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');
  expect(notice.match(/^Copyright (?:20\d{2}|© \d{4}).*$/gm)).toEqual([
    "Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)",
    "Copyright 2014 The Heebo Project Authors (https://github.com/OdedEzer/heebo)",
    'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"',
  ]);
  expect(notice.match(/with Reserved Font Name "Plex"/g)).toHaveLength(1);
  expect(notice.match(/SIL OPEN FONT LICENSE Version 1\.1/g)).toHaveLength(3);
  for (const asset of FONT_FILES) expect(notice).toContain(asset.sha256);
});

function firstFamily(value: string) {
  return value.split(",", 1)[0].trim().replace(/^['"]|['"]$/g, "");
}

async function collectRenderedFontEvidence(page: Page) {
  return page.evaluate(async ({ groups }) => {
    const normalizeFamily = (value: string) => value.trim().replace(/^['"]|['"]$/g, "");
    const first = (value: string) => normalizeFamily(value.split(",", 1)[0]);
    const rootStyle = getComputedStyle(document.documentElement);
    const variableNames = ["--font-serif", ...groups.map((group) => group.variable)];
    const variables = Object.fromEntries(
      variableNames.map((variable) => [variable, rootStyle.getPropertyValue(variable).trim()]),
    );

    let code = document.querySelector("code[data-font-smoke]");
    if (!code) {
      code = document.createElement("code");
      code.setAttribute("data-font-smoke", "true");
      code.textContent = "AOA-ČŽ-Кириллица";
      document.body.append(code);
    }

    const h1 = document.querySelector("h1");
    if (!h1) throw new Error("Font smoke needs the mounted sign-in heading");

    for (const group of groups) {
      const family = first(variables[group.variable]);
      for (const weight of group.weights) {
        const loaded = await document.fonts.load(`${weight} 16px "${family}"`, group.sample);
        if (!loaded.some((face) => normalizeFamily(face.family) === family && face.weight === weight)) {
          throw new Error(`${group.variable} ${weight} did not resolve to its bundled FontFace`);
        }
      }
    }
    await document.fonts.ready;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas font measurement context is unavailable");
    // Pin Canvas text shaping to the same kerning/spacing contract used for
    // the old Google-hosted and new bundled faces; Chrome's `auto` kerning
    // differs from DOM layout by roughly two pixels for this regression string.
    context.fontKerning = "normal";
    context.letterSpacing = "0px";
    const newsreaderFamily = first(variables["--font-serif-latin"]);
    const widthSample = "Always-On Advice Client Portrait AMi0";
    const newsreaderWidths = Object.fromEntries(["400", "500", "600"].map((weight) => {
      context.font = `${weight} 32px "${newsreaderFamily}"`;
      return [weight, context.measureText(widthSample).width];
    }));

    return {
      variables,
      newsreaderWidths,
      applied: {
        body: getComputedStyle(document.body).fontFamily,
        heading: getComputedStyle(h1).fontFamily,
        code: getComputedStyle(code).fontFamily,
      },
      faces: [...document.fonts].map((face) => ({
        family: normalizeFamily(face.family),
        weight: face.weight,
        style: face.style,
        status: face.status,
      })),
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      background: getComputedStyle(document.body).backgroundColor,
      width: document.documentElement.clientWidth,
      resources: performance.getEntriesByType("resource").map((entry) => entry.name)
        .filter((url) => /\.(?:woff2|ttf)(?:\?|$)/.test(url)),
    };
  }, { groups: FONT_GROUPS });
}

test("all bundled weights render from same-origin assets in light and dark narrow layouts", async ({ page }) => {
  const externalAttempts: string[] = [];
  for (const pattern of ["https://fonts.googleapis.com/**", "https://fonts.gstatic.com/**"]) {
    await page.route(pattern, async (route) => {
      externalAttempts.push(route.request().url());
      await route.abort("blockedbyclient");
    });
  }

  const fontResponses: Array<{ url: string; status: number; cacheControl: string }> = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "font") return;
    fontResponses.push({
      url: response.url(),
      status: response.status(),
      cacheControl: response.headers()["cache-control"] ?? "",
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Dev sign-in", exact: true })).toBeVisible();
  await expect.poll(
    () => new Set(fontResponses.map(({ url }) => url)).size,
    { message: "only the four primary Latin/sans/mono font assets should preload" },
  ).toBe(4);

  const light = await collectRenderedFontEvidence(page);
  expect(light.theme).toBe("light");
  expect(light.width).toBe(390);
  expect(firstFamily(light.applied.body)).toBe(firstFamily(light.variables["--font-sans"]));
  expect(firstFamily(light.applied.heading)).toBe(firstFamily(light.variables["--font-serif"]));
  expect(firstFamily(light.applied.code)).toBe(firstFamily(light.variables["--font-mono"]));
  for (const [weight, expectedWidth] of Object.entries({
    "400": 543.087646484375,
    "500": 557.4022216796875,
    "600": 573.433349609375,
  })) {
    expect(
      Math.abs(light.newsreaderWidths[weight] - expectedWidth),
      `Newsreader ${weight} width drifted`,
    ).toBeLessThanOrEqual(1);
  }

  for (const group of FONT_GROUPS) {
    const family = firstFamily(light.variables[group.variable]);
    for (const weight of group.weights) {
      expect(light.faces).toContainEqual({ family, weight, style: "normal", status: "loaded" });
    }
  }

  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveClass(/(?:^|\s)dark(?:\s|$)/);
  const dark = await collectRenderedFontEvidence(page);
  expect(dark.theme).toBe("dark");
  expect(dark.background).not.toBe(light.background);
  expect(dark.variables).toEqual(light.variables);
  expect(dark.applied).toEqual(light.applied);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveClass(/(?:^|\s)dark(?:\s|$)/);
  await expect(page.getByRole("heading", { name: "Dev sign-in", exact: true })).toBeVisible();
  const reloaded = await collectRenderedFontEvidence(page);
  expect(reloaded.theme).toBe("dark");
  expect(reloaded.width).toBe(390);

  // Public-directory files still inherit AOA's session boundary unless the
  // middleware explicitly exempts them. Verify the notice through the real
  // synthetic local session rather than weakening that boundary for a test.
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)" }).click();
  await expect(page.getByRole("heading", { name: "Command Center", exact: true })).toBeVisible();
  const licensedNotice = await page.evaluate(async () => {
    const noticeResponse = await fetch("/fonts/NOTICE.txt");
    return { status: noticeResponse.status, body: await noticeResponse.text() };
  });
  expect(licensedNotice.status).toBe(200);
  expect(licensedNotice.body).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');

  expect(externalAttempts).toEqual([]);
  const sameOriginFontUrls = new Set([
    ...fontResponses.map(({ url }) => url),
    ...light.resources,
    ...dark.resources,
    ...reloaded.resources,
  ]);
  expect(sameOriginFontUrls.size).toBe(6);
  for (const url of sameOriginFontUrls) expect(new URL(url).origin).toBe(new URL(page.url()).origin);
  expect(fontResponses.length).toBeGreaterThanOrEqual(6);
  for (const fontResponse of fontResponses) {
    expect(fontResponse.status, fontResponse.url).toBeGreaterThanOrEqual(200);
    expect(fontResponse.status, fontResponse.url).toBeLessThan(400);
    expect(fontResponse.cacheControl, fontResponse.url).toMatch(/(?:immutable|max-age=[1-9]\d*)/i);
  }
});
