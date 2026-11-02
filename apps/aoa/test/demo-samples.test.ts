// The public demo's sample data (lib/demo/samples): the generated files are current, every client has a sample that
// matches its own accounts, the showcase clients have every section written and dated in step with the seed, and the
// pieces only this demo holds (second members' own accounts, older trade requests) never claim a link to another demo.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildDemoSamples, buildWorkflowSample, planTaxBudgets, sampleWorld } from "@/lib/demo/samples/build";
import { demoClientSample, demoDualViewScenario, demoShowcaseClients } from "@/lib/demo/samples/clients";
import { sampleWhen, seedDay } from "@/lib/demo/samples/dates";
import { demoWorkflow } from "@/lib/demo/samples/workflow";
import { tradeRequestOnlyHere } from "@/lib/demo/links";
import { ownAccounts } from "@/lib/demo/seed/own-accounts";
import { ACCOUNT_TYPE_LABEL } from "@/lib/demo/seed/people";
import { planTradeRequests } from "@/lib/demo/seed/trade-requests-plan";
import { withOwnTradeRecords } from "@/lib/demo/seed/trade-requests-own";
import { householdIds, loadUniverse, membersOf, personIds } from "@/lib/demo/seed/universe";
import { DOCS } from "@/lib/mock/apex-docs";
import { NUDGE_TEMPLATES } from "@/lib/mock/workflow";

const universe = loadUniverse();
const json = (file: string) => JSON.parse(readFileSync(new URL(`../lib/demo/samples/data/${file}`, import.meta.url), "utf8"));
const SHOWCASE = ["okafor-kofi", "okafor-ada", "lindqvist-erik", "brennan-maeve"];

describe("demo sample data", () => {
  it("is current with the universe and showcase.ts (npm run demo:samples rewrites it)", () => {
    expect(json("clients.json")).toEqual(JSON.parse(JSON.stringify(buildDemoSamples(universe))));
    expect(json("workflow.json")).toEqual(JSON.parse(JSON.stringify(buildWorkflowSample(universe))));
  });

  it("has a sample for every client, whose beneficiaries sit on that client's own accounts", () => {
    const samples = buildDemoSamples(universe);
    const world = sampleWorld(universe);
    const ids = personIds(universe);
    expect(Object.keys(samples.clients).sort()).toEqual([...ids.values()].sort());
    for (const person of universe.people) {
      const sample = samples.clients[ids.get(person.id)!];
      const accounts = world.accountsOfPerson(person.id).map((a) => `${ACCOUNT_TYPE_LABEL[a.type]} ••••${a.number.slice(-4)}`);
      for (const b of sample.bene) expect(accounts, `${person.id} ${b.acct} ${b.num}`).toContain(`${b.acct} ${b.num}`);
      const byAccount = new Map<string, number>();
      for (const b of sample.bene) byAccount.set(b.num, (byAccount.get(b.num) ?? 0) + b.pct);
      for (const [num, pct] of byAccount) expect(pct, `${person.id} ${num}`).toBe(100);
      expect(Object.keys(sample.portrait)).toEqual(["Family", "Goals", "Communication", "Behavior", "Worry", "Themes"]);
      const others = membersOf(universe, person.household).filter((m) => m.id !== person.id).map((m) => m.first);
      for (const name of others) expect(sample.portrait.Family).toContain(name);
    }
  });

  it("writes every section for the showcase clients, and only for them", () => {
    const samples = buildDemoSamples(universe);
    const ids = personIds(universe);
    expect(samples.showcase.map((s) => s.id)).toEqual(SHOWCASE.map((p) => ids.get(p)));
    for (const [id, sample] of Object.entries(samples.clients)) {
      const showcase = samples.showcase.some((s) => s.id === id);
      expect(sample.showcase).toBe(showcase);
      if (!showcase) {
        expect(sample.prep).toBeNull();
        expect(sample.dualView).toBeNull();
        continue;
      }
      expect(sample.bene.length).toBeGreaterThan(0);
      expect(sample.prep?.recentSignals.length).toBeGreaterThan(1);
      expect(sample.prep?.openItems.length).toBeGreaterThan(1);
      expect(sample.dualView?.realTime.length).toBeGreaterThanOrEqual(4);
      expect(sample.dualView?.historical.length).toBeGreaterThanOrEqual(3);
      expect(new Set(sample.dualView?.insights.map((i) => i.tone))).toEqual(new Set(["opportunity", "risk", "context", "healthy"]));
    }
  });

  it("gives the household's Dual-View tenure and the first account's dates from the seeded accounts", () => {
    const kofi = buildDemoSamples(universe).clients[personIds(universe).get("okafor-kofi")!];
    expect(kofi.prep?.tenure).toBe("3 years");
    expect(kofi.prep?.aum).toBe("$501K");
    const history = kofi.dualView!.historical;
    expect(history.map((m) => m.daysAgo)).toEqual([21, 1_124, 1_130]);
  });

  it("serves a client's sections with dates placed from the seed's day", () => {
    const now = new Date("2026-11-02T15:00:00Z"); // a Monday
    const kofi = demoClientSample(personIds(universe).get("okafor-kofi")!, now)!;
    // 21 business days before Monday Nov 2: Friday Oct 2.
    expect(kofi.prep?.lastMeeting).toBe("Oct 2, 2026 — Statement review call");
    expect(sampleWhen(0, now)).toBe("Today");
    expect(sampleWhen(1, now)).toBe("Oct 30");
    expect(sampleWhen(1_130, now)).toBe("Sep 2023");
    // Saturday's seed day is Friday.
    expect(seedDay(new Date("2026-10-31T15:00:00Z")).toISOString().slice(0, 10)).toBe("2026-10-30");
    expect(demoClientSample("003DM0000009999XXX")).toBeNull();
  });

  it("gives Dual-View a single written story for a showcase client and points the rest to them", () => {
    const ids = personIds(universe);
    const story = demoDualViewScenario(ids.get("okafor-ada")!)!;
    expect(story.fixture.dualView.brief).toContain("HD-2481");
    expect(story.risk.tolerance).toBe("Growth");
    expect(demoDualViewScenario(ids.get("alvarez-lucia") ?? "none")).toBeNull();
    expect(demoShowcaseClients().map((c) => c.name)).toEqual(["Kofi Okafor", "Ada Okafor", "Erik Lindqvist", "Maeve Brennan"]);
  });

  it("keys the reminders to seeded households and clients, with templates and documents the app knows", () => {
    const { decisions, nudges } = demoWorkflow(new Date("2026-11-02T15:00:00Z"));
    const households = householdIds(universe);
    const sf = personIds(universe);
    expect(decisions.map((d) => d.householdName)).toEqual(["Okafor Household", "Lindqvist Household", "Brennan Household"]);
    expect(decisions.map((d) => d.householdId)).toEqual(["okafor", "lindqvist", "brennan"].map((h) => households.get(h)));
    for (const n of nudges) {
      expect([...sf.values()]).toContain(n.clientId);
      expect(NUDGE_TEMPLATES.map((t) => t.id)).toContain(n.templateId);
    }
    for (const task of decisions.flatMap((d) => d.items.flatMap((i) => i.tasks))) {
      expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const doc of task.docs ?? []) expect(Object.keys(DOCS)).toContain(doc.code);
    }
    expect(decisions[0].meeting).toBe("Statement review · Oct 2");
  });

  it("budgets every client's realized gains, with the showcase clients' own figures", () => {
    const budgets = planTaxBudgets(universe);
    expect(budgets).toHaveLength(universe.people.length);
    expect(budgets.find((b) => b.person === "brennan-maeve")).toMatchObject({ budget: 15_000, realized: 9_240, prior: 12_000 });
    for (const b of budgets) expect(b.budget).toBeGreaterThan(0);
  });
});

describe("what only this demo holds", () => {
  it("gives every second member one account of their own, numbered apart from the universe's", () => {
    const own = ownAccounts(universe);
    const second = universe.households.flatMap((h) => membersOf(universe, h.id).slice(1)).map((p) => p.id);
    expect(own.map((a) => a.owner)).toEqual(second);
    const numbers = new Set(universe.accounts.map((a) => a.number));
    for (const a of own) expect(numbers.has(a.number)).toBe(false);
    expect(new Set(own.map((a) => a.number)).size).toBe(own.length);
    expect(own.find((a) => a.owner === "okafor-ada")).toMatchObject({ type: "sep-ira", value: 88_340 });
  });

  it("adds the older funding requests below the shared ids, and links only shared requests to the other demo", () => {
    const shared = planTradeRequests(universe);
    const plan = withOwnTradeRecords(shared, universe);
    const added = plan.requests.slice(shared.requests.length);
    expect(added.map((r) => r.id)).toEqual(["REQ-00000901", "REQ-00000902", "REQ-00000903"]);
    for (const r of added) {
      expect(r).toMatchObject({ tradeType: "Initial Funding", status: "Completed" });
      expect(tradeRequestOnlyHere(r.id)).toBe(true);
    }
    for (const r of shared.requests) expect(tradeRequestOnlyHere(r.id)).toBe(false);
    expect(plan.accounts.length).toBe(shared.accounts.length + ownAccounts(universe).length);
    // Ada's SEP IRA request names Ada, on her own account.
    expect(added[0].clientNames).toEqual(["Ada Okafor"]);
  });
});
