import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_COMMANDS } from "../scripts/trade-requests/cutover-job";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(path.join(ROOT, d))) {
      const rel = path.join(d, name);
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (exts.some((e) => name.endsWith(e))) out.push(rel);
    }
  };
  if (existsSync(path.join(ROOT, dir))) walk(dir);
  return out;
}

/** Relative imports of a TypeScript file, resolved to repository paths (.ts, .tsx or /index.ts). */
function relativeImports(rel: string): string[] {
  const src = read(rel);
  const specs = [...src.matchAll(/(?:import|export)[^"';]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
  return specs
    .filter((s) => s.startsWith("."))
    .map((s) => {
      const base = path.normalize(path.join(path.dirname(rel), s));
      const hit = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((c) => existsSync(path.join(ROOT, c)));
      if (!hit) throw new Error(`${rel}: unresolved import ${s}`);
      return hit;
    });
}

describe("cutover structure", () => {
  // A textual guard over application code; the database is the real one: app_rw holds only SELECT on both tables
  // (ticket's migration), so only an owner connection such as this job's can write them at all.
  it("has exactly one writer of the serving state and its transition logs", () => {
    const writes =
      /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?(ONLY\s+)?"?trade_request"?\s*\.\s*"?(serving_state(_transitions)?|standalone_transitions)\b/i;
    const writers = [...files("lib", [".ts", ".tsx"]), ...files("app", [".ts", ".tsx"]), ...files("scripts", [".ts", ".mjs", ".cjs", ".sh"])].filter((f) =>
      writes.test(read(f)),
    );
    expect(writers).toEqual(["lib/trade-requests/serving-state-admin.ts"]);
  });

  it("runs every job command from scripts/ and lib/trade-requests/ only, with no server-only or @/ import", () => {
    const seen = new Set<string>();
    const queue = [...new Set(Object.values(JOB_COMMANDS).map(([script]) => script)), "scripts/trade-requests/cutover-job.ts"];
    while (queue.length > 0) {
      const rel = queue.pop()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      expect(rel.startsWith("scripts/") || rel.startsWith("lib/trade-requests/"), rel).toBe(true);
      const src = read(rel);
      expect(/from\s+["']server-only["']|import\s+["']server-only["']/.test(src), `${rel} imports server-only`).toBe(false);
      expect(/from\s+["']@\//.test(src), `${rel} uses the @/ alias`).toBe(false);
      queue.push(...relativeImports(rel));
    }
    expect(seen.has("lib/trade-requests/cutover-controller.ts")).toBe(true);
  });

  it("never names AOA's own schema in the controller modules (zero AOA user or account writes)", () => {
    const modules = [
      "lib/trade-requests/cutover-clock.ts",
      "lib/trade-requests/cutover-connection.ts",
      "lib/trade-requests/cutover-controller.ts",
      "lib/trade-requests/cutover-gates.ts",
      "lib/trade-requests/serving-state-admin.ts",
      "lib/trade-requests/standalone-control.ts",
      "scripts/trade-requests/cutover.ts",
      "scripts/trade-requests/cutover-job.ts",
    ];
    const appSchema = /"?\bapp"?\s*\.\s*"?(User|Account)\b|"app"\./;
    expect(modules.filter((f) => appSchema.test(read(f)))).toEqual([]);
  });
});
