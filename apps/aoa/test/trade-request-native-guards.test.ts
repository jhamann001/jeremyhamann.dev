import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards for the Trade Request backend move (ticket): no asset location engine code in AOA (epic AC-91), no
// execution-plan view, engine control or asset-location mode selector on any AOA screen (AC-92), and every
// ported native SQL statement names the copied records by their trade_request schema.

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
function files(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (SOURCE.test(name)) out.push(path);
  }
  return out;
}

// The standalone engine's exports and routes (trade-request d41b6c9 server/src/services/assetLocationEngine.ts
// :322 and :397; server/src/routes/requests.ts:1368, :1429, :1600) and its package.
const ENGINE_CODE = [
  /\brunAssetLocationEngine\b/, /\bverifyExecutionPlans\b/, /\bassetLocationEngine\b/, /asset-location-engine/,
  /@trade-request\/allocations/, /\/run-engine\b/, /\/classified-holdings\b/, /\/household-holdings\b/,
];
const ENGINE_FILE = /asset[-_]?location[-_]?engine/i;

export function engineHits(path: string, text: string): string[] {
  const hits = ENGINE_CODE.filter((pattern) => pattern.test(text)).map((pattern) => `${path}: ${pattern.source}`);
  if (ENGINE_FILE.test(path)) hits.push(`${path}: file name`);
  return hits;
}

// Copy that names the plan without rendering one (ticket owns its wording).
const ALLOWED_COPY = [/TRADE_TYPE_COPY\.executionPlanLead\b/g, /TRADE_TYPE_COPY\.executionPlan\b/g];
const PLAN_VIEW = [
  /\bexecutionPlan\b/, /\bExecutionPlan\b/, /\bassetLocationMode\b/, /data-testid=["'`]execution-plan/,
  /\/run-engine\b/, /run engine/i, /asset[- ]location mode/i,
];

export function planViewHits(path: string, text: string): string[] {
  const visible = ALLOWED_COPY.reduce((current, pattern) => current.replace(pattern, ""), text);
  return PLAN_VIEW.filter((pattern) => pattern.test(visible)).map((pattern) => `${path}: ${pattern.source}`);
}

const CATALOG = [
  "users", "clients", "accounts", "trade_requests", "audit_logs", "notifications", "client_exclusions", "account_exclusions",
  "digest_runs", "registry_drift_runs", "position_drift_accounts", "drift_alert_sends", "drift_status_overrides", "security_sector",
];
const TABLE_REFERENCE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w."]*)/g;

export function sqlReferences(text: string): { qualified: number; unqualified: string[] } {
  let qualified = 0;
  const unqualified: string[] = [];
  for (const match of text.matchAll(TABLE_REFERENCE)) {
    const name = match[1].replace(/"/g, "");
    if (name.startsWith("trade_request.")) qualified += 1;
    else if (CATALOG.includes(name)) unqualified.push(name);
  }
  return { qualified, unqualified };
}

describe("Trade Request backend move guards", () => {
  it("finds no asset location engine code in AOA", () => {
    const scanned = ["lib", "app", "components", "scripts"].flatMap(files);
    expect(scanned.length).toBeGreaterThan(500);
    expect(scanned.flatMap((path) => engineHits(path, readFileSync(path, "utf8")))).toEqual([]);
  });

  it("detects engine code and an engine file", () => {
    expect(engineHits("lib/x.ts", 'import { runAssetLocationEngine } from "./engine";')).toHaveLength(1);
    expect(engineHits("lib/x.ts", 'await fetch(`/api/requests/${id}/run-engine`)')).toHaveLength(1);
    expect(engineHits("lib/asset-location-engine.ts", "export const x = 1;")).toEqual(["lib/asset-location-engine.ts: file name"]);
  });

  it("finds no execution-plan view, engine control or asset-location mode selector on any screen", () => {
    const scanned = ["app", "components"].flatMap(files);
    expect(scanned.length).toBeGreaterThan(200);
    expect(scanned.flatMap((path) => planViewHits(path, readFileSync(path, "utf8")))).toEqual([]);
  });

  it("detects a plan view, an engine control and a mode selector, but not the allowed note copy", () => {
    expect(planViewHits("c.tsx", "<ExecutionPlan plans={request.executionPlan} />")).toHaveLength(2);
    expect(planViewHits("c.tsx", '<select name="assetLocationMode"><option>Priority</option></select>')).toHaveLength(1);
    expect(planViewHits("c.tsx", "<button>Run engine</button>")).toHaveLength(1);
    expect(planViewHits("c.tsx", "{TRADE_TYPE_COPY.executionPlanLead} {TRADE_TYPE_COPY.executionPlan}")).toEqual([]);
  });

  it("qualifies every copied-record table in the native read SQL with trade_request", () => {
    const dir = "lib/trade-requests/native/reads";
    const totals = readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => sqlReferences(readFileSync(join(dir, name), "utf8")));
    expect(totals.flatMap((t) => t.unqualified)).toEqual([]);
    expect(totals.reduce((sum, t) => sum + t.qualified, 0)).toBeGreaterThanOrEqual(15);
  });

  it("detects an unqualified copied-record table", () => {
    expect(sqlReferences("SELECT * FROM trade_requests tr LEFT JOIN users u ON u.id = tr.advisor_id")).toEqual({ qualified: 0, unqualified: ["trade_requests", "users"] });
    expect(sqlReferences("SELECT 1 FROM trade_request.trade_requests")).toEqual({ qualified: 1, unqualified: [] });
  });
});
