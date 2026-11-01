/**
 * The `/admin/flags` catalog.
 *
 * Two of these are worth more than the rest: the catalog must name only env keys that actually exist
 * in `src/lib/env.ts` (a flag for a variable nobody reads is a page that lies), and the page's
 * presence map must cover every key the catalog names (a key missing from the map reads as "off"
 * forever). Both are read as TEXT, because the page is a server module a component test may not
 * import and `@/lib/env` throws on an unparseable environment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLAG_AREAS, FLAG_CATALOG, groupByArea, toFlagRows } from "@/components/admin/flags/flag-catalog";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..", "..");

const ENV_SOURCE = readFileSync(path.join(REPO_ROOT, "src/lib/env.ts"), "utf8");
const PAGE_SOURCE = readFileSync(path.join(REPO_ROOT, "src/app/(app)/admin/flags/page.tsx"), "utf8");

const ALL_KEYS = FLAG_CATALOG.flatMap((f) => [...f.envKeys]);

describe("the catalog", () => {
  it("has a unique id per capability and a unique env key per row", () => {
    const ids = FLAG_CATALOG.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });

  it("puts every capability in a declared area", () => {
    for (const f of FLAG_CATALOG) expect(FLAG_AREAS).toContain(f.area);
  });

  it("names only environment variables that src/lib/env.ts actually declares", () => {
    for (const key of ALL_KEYS) {
      expect(ENV_SOURCE.includes(`${key}:`), `${key} is not declared in src/lib/env.ts`).toBe(true);
    }
  });

  it("is fully covered by the page's presence map — a missing key would read as OFF forever", () => {
    for (const key of ALL_KEYS) {
      expect(PAGE_SOURCE.includes(`${key}:`), `${key} is missing from the /admin/flags presence map`).toBe(true);
    }
  });

  it("says what happens while each capability is off, because off is the shipped state", () => {
    for (const f of FLAG_CATALOG) {
      expect(f.whileOff.length, f.id).toBeGreaterThan(20);
      expect(f.effect.length, f.id).toBeGreaterThan(20);
    }
  });

  it("carries no value, example or placeholder that could be mistaken for one", () => {
    // A catalog entry is a NAME and prose. Nothing here may look like a secret, a URL or a JSON blob.
    const text = JSON.stringify(FLAG_CATALOG);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/[A-Za-z0-9+/]{32,}={0,2}/);
  });
});

describe("toFlagRows", () => {
  const specs = FLAG_CATALOG.filter((f) => f.id === "mcp" || f.id === "web-push");

  it("is on only when every key of an all-or-nothing group is set", () => {
    const rows = toFlagRows(specs, {
      MCP_ENABLED: true,
      VAPID_PUBLIC_KEY: true,
      VAPID_PRIVATE_KEY: true,
      VAPID_SUBJECT: true,
    });
    for (const r of rows) {
      expect(r.enabled, r.id).toBe(true);
      expect(r.partiallyConfigured, r.id).toBe(false);
    }
  });

  it("reports a half-configured group rather than rounding it down to OFF", () => {
    const [push] = toFlagRows(
      specs.filter((s) => s.id === "web-push"),
      { VAPID_PUBLIC_KEY: true },
    );
    expect(push.enabled).toBe(false);
    expect(push.partiallyConfigured).toBe(true);
  });

  it("treats a key absent from the map as unset — fail closed", () => {
    const rows = toFlagRows(FLAG_CATALOG, {});
    expect(rows.every((r) => !r.enabled)).toBe(true);
    expect(rows.every((r) => !r.partiallyConfigured)).toBe(true);
  });

  it("carries the first env key as the row key, never a value", () => {
    const [push] = toFlagRows(
      specs.filter((s) => s.id === "web-push"),
      {},
    );
    expect(push.key).toBe("VAPID_PUBLIC_KEY");
  });
});

describe("groupByArea", () => {
  it("keeps the declared area order and drops empty areas", () => {
    const rows = toFlagRows(FLAG_CATALOG, {});
    const groups = groupByArea(rows);
    expect(groups.map((g) => g.area)).toEqual(FLAG_AREAS.filter((a) => rows.some((r) => r.area === a)));
    expect(groups.every((g) => g.rows.length > 0)).toBe(true);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
  });
});
