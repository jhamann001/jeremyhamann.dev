import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Operations Tools UI boundaries", () => {
  const layout = read("app/(authenticated)/layout.tsx");
  const nav = read("components/shell/nav-config.ts");
  const sidebar = read("components/shell/Sidebar.tsx");
  const hub = read("app/(authenticated)/operations/page.tsx");
  const route = read("app/(authenticated)/operations/trade-reconciliation/page.tsx");
  const runForm = read("app/(authenticated)/operations/trade-reconciliation/RunReconciliationForm.tsx");
  const actions = read("app/(authenticated)/operations/trade-reconciliation/actions.ts");
  const prototype = read("components/operations/TradeReconciliationPrototype.tsx");
  const data = read("lib/data/trade-reconciliation.ts");

  it("gates both navigation and direct routes", () => {
    expect(nav).toContain('requiresOperationsTools: true');
    expect(nav).toContain('requiredRoles: ["ADMIN", "OPERATIONS"]');
    expect(sidebar).toContain("!item.requiresOperationsTools || operationsTools");
    expect(layout).toContain("operationsTools={operationsToolsEnabled()}");
    expect(hub).toContain("canAccessOperationsTools(role)");
    expect(route).toContain("canAccessOperationsTools(role)");
    expect(route).toContain("operationsTradeReconciliationPreviewEnabled()");
    expect(route).toContain('href="/api/operations/trade-reconciliation/export"');
    expect(route).toContain("Export all runs");
  });

  it("labels the live development boundary and keeps source access server-side", () => {
    expect(hub).toContain("Development rollout");
    expect(route).toContain("Live development data");
    expect(route).toContain("account IDs are masked before persistence");
    expect(route).toContain("account-aware-v2");
    expect(route).not.toContain("prisma");
    expect(route).not.toContain("withUserScope");
    expect(actions).toContain("fetchTradeReconciliationSources");
    expect(actions).toContain("persistCompletedTradeReconciliation");
    expect(actions).toContain("previousTradingDay(runDate)");
    expect(actions).toContain('formData.get("runDate")');
    expect(runForm).toContain('name="runDate"');
    expect(runForm).toContain("Trade date");
    expect(route).toContain("Trade date");
    expect(prototype).not.toContain('"use server"');
  });

  it("keeps the initial result blank until a user explicitly runs or opens one", () => {
    expect(route).not.toContain("mostRecentTradingDay");
    expect(route).toContain("const initialRunDate = first(query.date) ?? data.run?.runDate ?? maximumRunDate;");
    expect(runForm).toContain("No reconciliation is due today because NYSE is closed.");
    expect(runForm).toContain('const [runDate, setRunDate] = useState(initialRunDate)');
    expect(runForm).toContain("disabled={!tradeDate}");
    expect(runForm).toContain("Nothing is queried until you run the reconciliation.");
    expect(data).toContain("where: { id: requestedRunId }");
    expect(data).not.toContain("runs[0]?.id");
    expect(data).toContain("if (!requestedRunId || !isTradeReconciliationRunId(requestedRunId))");
    expect(actions).toContain("loadTradeReconciliationHistory");
    expect(prototype).toContain("Loading reconciliation history");
    expect(route).toContain("currentRunAvailable={Boolean(data.run)}");
    expect(route).toContain('key={data.run?.id ?? "blank"}');
    expect(prototype).toContain("No reconciliation loaded.");
    expect(prototype).toContain("open History to review a previously completed run");
  });

  it("prefetches both tool routes and provides route-level loading shells", () => {
    expect(hub).toContain('href="/operations/trade-reconciliation" prefetch');
    expect(hub).toContain('href="/operations/fee-requests" prefetch');
    expect(read("app/(authenticated)/operations/trade-reconciliation/loading.tsx")).toContain("aria-busy");
    expect(read("app/(authenticated)/operations/fee-requests/loading.tsx")).toContain("aria-busy");
  });

  it("offers the agreed current, history, filter, and explanation controls", () => {
    for (const label of ["Summary", "Breaks", "Detail", "Aggregated", "Daily", "Monthly", "Quarterly"]) {
      expect(prototype).toContain(`label: "${label}"`);
    }
    expect(prototype).toContain("All breaks");
    expect(prototype).toContain("Unresolved");
    expect(prototype).toContain("Explained");
    expect(prototype).toContain("Save review");
    expect(prototype).toContain("Select all filtered unresolved");
    expect(prototype).toContain("Clear selection");
    expect(prototype).toContain("Save reviews");
    expect(prototype).toContain('useState<BreakFilter>("unresolved")');
    expect(prototype).toContain("explained ? <span");
    expect(prototype).toContain("Columns (");
    expect(prototype).toContain("Apex net amount");
    expect(prototype).toContain("Meridian notional");
    expect(prototype).toContain("Compared as");
    expect(prototype).toContain('{ id: "notes", label: "Notes" }');
    expect(prototype.match(/"notes",/g)).toHaveLength(3);
    expect(prototype).toContain('case "notes": return <BreakNote row={row} />;');
    expect(prototype).toContain("AOA scopes value-based matching by account, symbol, and side");
    expect(prototype).toContain("<TH>Run date</TH><TH>Trade date</TH><TH>Completed at</TH>");
    expect(prototype).not.toContain("Clear reconciliation");
    expect(prototype).not.toContain("Clear records");
  });
});
