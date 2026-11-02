import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "package.json"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const plugin = require("@next/eslint-plugin-next");
const expectedNextRules = [
  "google-font-display", "google-font-preconnect", "inline-script-id", "next-script-for-ga",
  "no-assign-module-variable", "no-async-client-component", "no-before-interactive-script-outside-document",
  "no-css-tags", "no-document-import-in-page", "no-duplicate-head", "no-head-element",
  "no-head-import-in-document", "no-html-link-for-pages", "no-img-element", "no-page-custom-font",
  "no-script-component-in-head", "no-styled-jsx-in-document", "no-sync-scripts",
  "no-title-in-document-head", "no-typos", "no-unwanted-polyfillio",
];
type LintMessage = { ruleId: string | null; severity: number; fatal?: boolean };
type LintEngine = {
  calculateConfigForFile(path: string): Promise<{ rules: Record<string, unknown>; plugins: string[] }>;
  lintText(source: string, options: { filePath: string }): Promise<{ messages: LintMessage[] }[]>;
};
let engine: LintEngine;
let fixture: string;

beforeAll(async () => {
  const ESLint = await require("eslint").loadESLint({ useFlatConfig: false });
  engine = new ESLint({ cwd: root, cache: false, useEslintrc: true, errorOnUnmatchedPattern: false });
  fixture = mkdtempSync(join(tmpdir(), "aoa-eslint-compat-"));
  for (const directory of ["alpha", "beta", ".hidden", "space dir", "nested/child"]) {
    mkdirSync(join(fixture, directory), { recursive: true });
  }
  writeFileSync(join(fixture, "not-a-directory.txt"), "synthetic");
});
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

describe("reviewed development lint dependency bridge", () => {
  it("pins only the compatible development engine and scoped Next plugin/glob", () => {
    expect(manifest.devDependencies.eslint).toBe("8.57.1");
    expect(manifest.devDependencies["eslint-config-next"]).toBe("15.5.22");
    expect(manifest.overrides["@next/eslint-plugin-next"]).toEqual({ ".": "14.2.35", glob: "10.5.0" });
    expect(require("eslint/package.json").version).toBe("8.57.1");
    expect(require("eslint-config-next/package.json").version).toBe("15.5.22");
    expect(require("@next/eslint-plugin-next/package.json").version).toBe("14.2.35");
    expect(manifest.dependencies.next).toBe("15.5.28");
    expect(require("next/package.json").version).toBe("15.5.28");
    expect(manifest.scripts.lint).toBe("next lint");
    expect(JSON.parse(readFileSync(join(root, ".eslintrc.json"), "utf8"))).toEqual({ extends: "next/core-web-vitals" });
  });

  it("removes the actual vulnerable chain rather than renaming or ignoring it", () => {
    const names = Object.entries(lock.packages).map(([path, entry]) => {
      const metadata = entry as { name?: string };
      return metadata.name ?? path.split("node_modules/").at(-1);
    });
    for (const name of ["braces", "micromatch", "fast-glob"]) expect(names).not.toContain(name);
    const pluginRequire = createRequire(require.resolve("@next/eslint-plugin-next/package.json"));
    expect(pluginRequire("glob/package.json").version).toBe("10.5.0");
    expect(lock.packages["node_modules/@next/eslint-plugin-next"].dev).toBe(true);
  });

  it("retains all 21 Next rules and both Core Web Vitals error severities", () => {
    expect(Object.keys(plugin.rules).sort()).toEqual([...expectedNextRules].sort());
    expect(plugin.configs["core-web-vitals"].rules).toEqual({
      "@next/next/no-html-link-for-pages": "error", "@next/next/no-sync-scripts": "error",
    });
    expect(Object.keys(plugin.configs.recommended.rules)).toHaveLength(21);
  });

  it("retains the complete 52-rule effective baseline, not just the Next rule names", async () => {
    const config = await engine.calculateConfigForFile(join(root, "components/SyntheticLint.tsx"));
    const rules = Object.entries(config.rules).sort(([a], [b]) => a.localeCompare(b));
    expect(rules).toHaveLength(52);
    // Captured from the real original eslint 9.39.5/config-next 15.5.22 engine.
    expect(createHash("sha256").update(JSON.stringify(rules)).digest("hex"))
      .toBe("2c93d0b0a7fd73b90f0755d780c984e2c83f96f723458d3dd07af353a9e07427");
    expect([...config.plugins].sort()).toEqual(["@next/next", "import", "jsx-a11y", "react", "react-hooks"]);
  });

  it.each([
    ["components/SyntheticLint.tsx", "const module = 'bad'; export default module;", "@next/next/no-assign-module-variable", 2],
    ["components/SyntheticLint.tsx", "export default function Page() { return <script src='/fixture.js' />; }", "@next/next/no-sync-scripts", 2],
    ["app/SyntheticPage.tsx", "import Document from 'next/document'; export default Document;", "@next/next/no-document-import-in-page", 2],
    ["components/SyntheticLint.tsx", "export default function Page() { return <head><title>Fixture</title></head>; }", "@next/next/no-head-element", 1],
    ["components/SyntheticLint.tsx", "export default function Page() { return <img src='/fixture.png' alt='fixture' />; }", "@next/next/no-img-element", 1],
    ["components/SyntheticLint.tsx", "export default function Page() { return <img src='/fixture.png' />; }", "jsx-a11y/alt-text", 1],
    ["components/SyntheticLint.tsx", "import {useState} from 'react'; export default function Page({ok}: {ok:boolean}) { if (ok) { useState(0); } return <main/>; }", "react-hooks/rules-of-hooks", 2],
    ["components/SyntheticLint.tsx", "'use client'; export default async function Page() { return <main/>; }", "@next/next/no-async-client-component", 1],
    ["pages/_document.tsx", "import Document, {Head} from 'next/document'; export default class Doc extends Document { render() { return <main><Head/><Head/></main>; } }", "@next/next/no-duplicate-head", 2],
    ["pages/SyntheticPage.tsx", "export default function Page() { return <link href='https://fonts.googleapis.com/css2?family=Inter' rel='stylesheet'/>; }", "@next/next/no-page-custom-font", 1],
  ])("still rejects %s with %s", async (path, source, ruleId, severity) => {
    const results = await engine.lintText(source, { filePath: join(root, String(path)) });
    const messages = results.flatMap(result => result.messages);
    expect(messages.some(message => message.fatal)).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId, severity })]));
  });

  it("accepts a valid JSX component without synthetic findings", async () => {
    const results = await engine.lintText("export default function Page() { return <main><p>Fixture</p></main>; }", {
      filePath: join(root, "components/SyntheticLint.tsx"),
    });
    expect(results.flatMap(result => result.messages)).toEqual([]);
  });

  it.each([
    ["alpha", ["alpha"]], ["alpha/", ["alpha"]], ["*", ["alpha", "beta", "nested", "space dir"]],
    ["{alpha,beta}", ["alpha", "beta"]], ["nested/*", ["nested/child"]],
    ["space dir", ["space dir"]], ["missing*", []], ["not-a-directory.txt", []],
  ])("preserves directory-only root matching for %s", (pattern, expected) => {
    const { getRootDirs } = require("@next/eslint-plugin-next/dist/utils/get-root-dirs.js");
    const context = { cwd: root, getCwd: () => root, settings: { next: { rootDir: join(fixture, pattern) } } };
    const paths = getRootDirs(context).map((path: string) => relative(fixture, path)).sort();
    expect(paths).toEqual(expected);
  });

  it("preserves the default project root and an array of explicit roots", () => {
    const { getRootDirs } = require("@next/eslint-plugin-next/dist/utils/get-root-dirs.js");
    const context = { cwd: root, getCwd: () => root, settings: {} };
    expect(getRootDirs(context)).toEqual([root]);
    expect(getRootDirs({ ...context, settings: { next: { rootDir: [join(fixture, "alpha"), join(fixture, "beta")] } } })
      .map((path: string) => relative(fixture, path)).sort()).toEqual(["alpha", "beta"]);
  });
});
