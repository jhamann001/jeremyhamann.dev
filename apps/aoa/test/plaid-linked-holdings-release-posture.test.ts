import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ticket release posture for the Plaid-linked holdings epic (ticket). The
// dark release keeps all three switches unset everywhere but the public demo,
// holdings never reach storage, asset mapping, AUM or the browser, and only
// the reviewed modules touch the summary mirror. Live Cloud Run readback stays
// a manual step in docs/operations/plaid-linked-holdings-release.md: deploys
// use --update-env-vars, so a repository scan cannot see out-of-band values.
//
// The demo (demo-config.json) turns the three switches on on purpose: it has
// no Plaid or warehouse behind it, and the warehouse cards the Plaid reads run
// are answered in-process by its stand-ins (lib/demo/stand-ins/warehouse.ts).

vi.mock("server-only", () => ({}));
const { standInRows } = vi.hoisted(() => ({ standInRows: new Map<string, unknown>() }));
vi.mock("@/lib/demo/stand-ins/store", () => ({
  listRecords: async (service: string, kind: string) =>
    [...standInRows.entries()]
      .filter(([key]) => key.startsWith(`${service}|${kind}|`))
      .map(([key, doc]) => ({ id: key.split("|")[2], doc, updatedAt: new Date() })),
  readRecord: async (service: string, kind: string, id: string) => {
    const doc = standInRows.get(`${service}|${kind}|${id}`);
    return doc === undefined ? null : { id, doc, updatedAt: new Date() };
  },
}));

const root = process.cwd();
const SWITCHES = [
  "EPIC_PLAID_LINKED_HOLDINGS",
  "SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES",
  "ALLOW_PLAID_HOLDINGS_PREVIEW",
];
const FORBIDDEN_FIELDS = ["access_token", "isin", "cusip", "cost_basis"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", ".git", "test-results"]);

function walk(relativeDirectory: string): string[] {
  const absolute = join(root, relativeDirectory);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) files.push(...walk(relative(root, path)));
    else files.push(relative(root, path));
  }
  return files;
}

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

const DEMO_CONFIG = "demo-config.json";

const deployConfiguration = [
  ...walk("infra"),
  ...walk(".github"),
  ...walk("scripts"),
  ...readdirSync(root).filter(
    (name) =>
      /^Dockerfile/.test(name) ||
      name === "docker-compose.yml" ||
      name === ".env.example" ||
      name === DEMO_CONFIG,
  ),
];

const runtimeSource = ["app", "components", "lib", "services"]
  .flatMap(walk)
  .concat(["middleware.ts", "auth.ts"])
  .filter((path) => /\.(ts|tsx|mjs|cjs|js)$/.test(path) && existsSync(join(root, path)));

function filesMatching(files: string[], pattern: RegExp): string[] {
  return files.filter((path) => pattern.test(read(path))).sort();
}

function importOf(modulePath: string): RegExp {
  return new RegExp(`(from\\s+|import\\s*\\(\\s*)["'][^"']*\\b${modulePath}["']`);
}

function isClientModule(source: string): boolean {
  return /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);
}

describe("Plaid-linked holdings dark release posture", () => {
  it("scans a non-empty deploy configuration and runtime source set", () => {
    // This copy carries no Terraform or deploy workflows (they stayed with the production repository).
    expect(deployConfiguration).toEqual(
      expect.arrayContaining(["Dockerfile", "docker-compose.yml", ".env.example", DEMO_CONFIG]),
    );
    expect(runtimeSource).toEqual(expect.arrayContaining(["lib/flags.ts", "lib/data/portrait.ts"]));
  });

  // The switches were turned on in production by hand, and only production Terraform (not in this copy) holds
  // those live values. No deploy, infrastructure or example configuration here may set them, but the demo's.
  it("sets the three switches in no deploy configuration this copy carries but the demo's", () => {
    for (const name of SWITCHES) {
      expect(filesMatching(deployConfiguration, new RegExp(`\\b${name}\\b`)), name).toEqual([DEMO_CONFIG]);
    }
    const demo = JSON.parse(read(DEMO_CONFIG)) as Record<string, string>;
    expect(demo.NEXT_PUBLIC_DEMO_MODE).toBe("on");
    for (const name of SWITCHES) expect(demo[name], name).toBe("1");
  });

  // What makes the demo's switches safe: the Plaid reads reach the warehouse only through the shared transport,
  // which sends through serviceFetch, the stand-ins in demo mode and the network otherwise.
  it("sends the Plaid warehouse reads only through the transport that answers from the stand-ins in the demo", () => {
    for (const path of [
      "lib/data/linked-external-holdings-preview.ts",
      "app/api/cron/linked-external-account-summary/route.ts",
    ]) {
      expect(read(path), path).toMatch(/import \{ queryWarehouseCard \} from "@\/lib\/warehouse\/client";/);
      expect(read(path), path).not.toMatch(/(?<![\w.])fetch\(/);
    }
    const transport = read("lib/warehouse/client.ts");
    expect(transport).toMatch(/import \{ serviceFetch \} from "@\/lib\/demo\/stand-ins\/fetch";/);
    expect(transport).not.toMatch(/(?<![\w.])fetch\(/);
  });

  describe("the Plaid warehouse reads at run time", () => {
    const network = vi.fn(async () => {
      throw new Error("the Plaid reads left the process");
    });
    const asError = (_reason: string, message: string) => new Error(message);

    afterEach(() => {
      standInRows.clear();
      network.mockClear();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    function withSettings(settings: Record<string, string>) {
      for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
      vi.stubGlobal("fetch", network);
    }

    it("are answered from the stand-ins under the demo's settings, never the network", async () => {
      withSettings(JSON.parse(read(DEMO_CONFIG)) as Record<string, string>);
      standInRows.set("warehouse|linked_summary|ext-1", { external_account_id: "ext-1", current_balance: 2300 });
      standInRows.set("warehouse|linked_holdings|ext-1", {
        rows: [{ ticker: "AAPL", security_name: "Apple Inc.", security_type: "equity", quantity: 10, market_value: 2300, current: 2300, as_of: "2026-10-29" }],
      });
      const { queryWarehouseCard } = await import("@/lib/warehouse/client");
      const { fetchLinkedHoldingsPreview } = await import("@/lib/data/linked-external-holdings-preview");

      expect(await queryWarehouseCard(6898, [], "plaid-posture", asError)).toEqual([
        { external_account_id: "ext-1", current_balance: 2300 },
      ]);
      expect(await fetchLinkedHoldingsPreview("ext-1")).toMatchObject({ asOf: "2026-10-29", rows: [expect.anything()] });
      expect(network).not.toHaveBeenCalled();
    });

    it("go to the network only outside demo mode", async () => {
      const { NEXT_PUBLIC_DEMO_MODE: _demo, ...rest } = JSON.parse(read(DEMO_CONFIG)) as Record<string, string>;
      withSettings({ ...rest, NEXT_PUBLIC_DEMO_MODE: "" });
      const { queryWarehouseCard } = await import("@/lib/warehouse/client");
      await expect(queryWarehouseCard(6898, [], "plaid-posture", asError)).rejects.toThrow("Warehouse fetch failed");
      expect(network).toHaveBeenCalledOnce();
    });
  });

  it("reads the three switches only through lib/flags.ts", () => {
    for (const name of SWITCHES) {
      expect(filesMatching(runtimeSource, new RegExp(`\\b${name}\\b`)), name).toEqual([
        "lib/flags.ts",
      ]);
    }
  });

  it("reaches the holdings preview module only from the portrait server action", () => {
    expect(filesMatching(runtimeSource, importOf("linked-external-holdings-preview"))).toEqual([
      "app/(authenticated)/client-portrait/[id]/actions.ts",
    ]);
    expect(read("app/(authenticated)/client-portrait/[id]/actions.ts")).toMatch(/^"use server";/);
  });

  it("keeps summary reads and the snapshot validator out of asset mapping and AUM", () => {
    expect(filesMatching(runtimeSource, importOf("linked-external-account-summary"))).toEqual([
      "app/(authenticated)/client-portrait/[id]/actions.ts",
      "lib/data/portrait.ts",
      "lib/data/transfer-linked-holdings.ts",
    ]);
    expect(filesMatching(runtimeSource, importOf("linked-external-account-summary-snapshot"))).toEqual([
      "app/api/cron/linked-external-account-summary/route.ts",
    ]);
  });

  it("touches mirror.linked_external_account_summary only from the reviewed modules", () => {
    expect(filesMatching(runtimeSource, /linked_external_account_summary/)).toEqual([
      "app/api/cron/linked-external-account-summary/route.ts",
      "lib/audit.ts",
      "lib/data/linked-external-account-summary-snapshot.ts",
      "lib/data/linked-external-account-summary.ts",
    ]);
  });

  it("never imports the Warehouse transport or Plaid data modules into a client component", () => {
    const clientModules = runtimeSource.filter((path) => isClientModule(read(path)));
    expect(clientModules).toContain("components/client-portrait/AccountsSection.tsx");
    const leaking = clientModules.filter((path) =>
      [
        importOf("lib/warehouse/client"),
        importOf("linked-external-holdings-preview"),
        importOf("linked-external-account-summary"),
        importOf("linked-external-account-summary-snapshot"),
      ].some((pattern) => pattern.test(read(path))),
    );
    expect(leaking).toEqual([]);
    expect(read("lib/warehouse/client.ts")).toMatch(/^import "server-only";/);
    expect(read("lib/data/linked-external-holdings-preview.ts")).toMatch(/^import "server-only";/);
  });

  it("exposes no Warehouse credential through a browser-visible environment variable", () => {
    expect(
      filesMatching([...runtimeSource, ...deployConfiguration, "next.config.mjs"], /NEXT_PUBLIC_[A-Z_]*WAREHOUSE/),
    ).toEqual([]);
  });

  it("stores no holdings and no forbidden Plaid fields in the database schema", () => {
    const migrations = walk("prisma/migrations").filter((path) => path.endsWith(".sql"));
    const holdingsTables = migrations.filter((path) =>
      /create\s+table\s+[\w."]*holding/i.test(read(path)),
    );
    expect(holdingsTables).toEqual([]);
    expect(read("prisma/schema.prisma")).not.toMatch(/model\s+\w*Holding/i);

    const mirror = read(
      "prisma/migrations/20261013000000_mirror_linked_external_account_summary/migration.sql",
    );
    const columns = mirror.match(
      /CREATE TABLE mirror\.linked_external_account_summary \(([\s\S]*?)\n\);/,
    )?.[1];
    expect(columns).toBeDefined();
    for (const field of FORBIDDEN_FIELDS) {
      expect(columns!, field).not.toMatch(new RegExp(`\\b${field}\\b`, "i"));
    }
    expect(columns).not.toMatch(/\bquantity\b|\bticker\b|\bsecurity_id\b/i);
  });
});
