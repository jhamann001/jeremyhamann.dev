// Demo seed part: the CRM funding pipeline. One deal per movement of money into the firm (transfers-plan.ts) at the
// stage that movement implies, by the deal → transfer sync's own map (lib/data/transfer-sync.ts: COMMITTED →
// Preparation, FUNDING → In transfer, WON → Funded; a Lost deal's transfer is archived), plus the Potential and Lost
// deals that never became a movement. Each deal goes in as the CRM feed writes it (source IMPORT, validated through
// validateDealInput, the import's own field mapping) with the stage timeline the feed and the app append
// ({stage, from, at, by}), a deal.stage_change audit row for every move a person made in the app, and one
// counts-only audit row per nightly CRM run that brought deals in or closed them.

import type { Prisma } from "@prisma/client";
import { DEAL_STAGE_CHANGE, INGEST_DEALS } from "@/lib/audit";
import type { DealInput, DealStage } from "@/lib/data/deal-types";
import { validateDealInput } from "@/lib/data/deal-validate";
import { dealInputToDbData } from "@/lib/deals/import-csv";
import type { SeedContext } from "./context";
import { planFundingWork, type DealPlan } from "./transfers-plan";
import { advisorSfId, cedarRidgeUserId, demoCuid, demoUuid } from "./universe";

// The CRM report's raw stage (import-only provenance), as the deal import carries it.
const STAGE_RAW: Record<DealStage, string> = {
  POTENTIAL: "Open",
  COMMITTED: "Open",
  FUNDING: "Open",
  WON: "Closed Won",
  LOST: "Closed Lost",
};

/** The deal as the CRM feed sends it (the shared DealInput contract). */
export function dealInput(ctx: SeedContext, deal: DealPlan): DealInput {
  const { universe } = ctx;
  const advisor = universe.staff.find((s) => s.id === deal.household.advisor)!;
  const client = deal.client;
  // The CRM's "person AUM": what the household already holds at the firm.
  const held = universe.accounts.filter((a) => a.household === deal.household.id).reduce((sum, a) => sum + a.value, 0);
  return {
    source: "IMPORT",
    sf_deal_id: deal.sfDealId,
    name: `${client.first} ${client.last} - ${deal.firm} - ${deal.accountType}${deal.last4 ? ` - ${deal.last4}` : ""}`,
    client_first_name: client.first,
    client_last_name: client.last,
    household_name: deal.household.name,
    household_sf_id: ctx.householdId.get(deal.household.id)!,
    client_sf_id: ctx.personId.get(client.id)!,
    amount: deal.amount,
    stage: deal.stage,
    stage_raw: STAGE_RAW[deal.stage],
    created_date: deal.history[0].day,
    close_date: deal.closeDay,
    last_activity_date: deal.lastActivity,
    owner_name: advisor.name,
    owner_sf_user_id: advisorSfId(universe, advisor.id),
    secondary_owner: null,
    person_aum: held > 0 ? held : null,
    potential_aum: deal.stage === "POTENTIAL" ? deal.amount : null,
    cedar_ridge_user_id: cedarRidgeUserId(client.id),
    statements: deal.statements,
    plaid_linked: false,
    account_last4: deal.last4,
    account_type: deal.accountType,
    transferring_firm: deal.firm,
    ...(deal.employer !== undefined ? { employer: deal.employer } : {}),
    ...(deal.rollingInto !== undefined ? { rolling_into: deal.rollingInto } : {}),
  };
}

/** A deal's id, the same on every seed: derived from its CRM opportunity id, as a transfer's is from its key, so
 *  /deals/[id] links and the audit trail's entity ids survive the nightly reset. */
export const dealId = (sfDealId: string): string => demoCuid(`deal:${sfDealId}`);

export async function seedDeals(ctx: SeedContext): Promise<Record<string, number>> {
  const work = planFundingWork(ctx);
  const deals = [...work.movements.map((m) => m.deal), ...work.pipelineDeals];
  const counts: Record<string, number> = { deals: deals.length };
  const feedRuns = new Map<string, number>();
  const rows: Prisma.DealCreateManyInput[] = [];
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  let stageChanges = 0;

  for (const deal of deals) {
    const input = dealInput(ctx, deal);
    const check = validateDealInput(input);
    if (!check.ok) {
      throw new Error(`Seed deal ${deal.sfDealId} fails validateDealInput: ${check.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
    }
    const timeline = deal.history.map((h) => ({ ...h, at: ctx.at(h.day, `${deal.sfDealId}:${h.stage}`) }));
    const lastAppMove = [...timeline].reverse().find((h) => h.by.email);
    const id = dealId(deal.sfDealId);
    rows.push({
      ...dealInputToDbData(input),
      id,
      // The feed's `by` is its source marker; a person's is their name (the D8 convention).
      stage_history: timeline.map((h) => ({ stage: h.stage, from: h.from, at: h.at.toISOString(), by: h.by.name })) as Prisma.InputJsonValue,
      asset_mapped: deal.assetMapped,
      lost_from: deal.lostFrom ?? null,
      updated_by: lastAppMove?.by.email ?? null,
      created_at: timeline[0].at,
      updated_at: timeline[timeline.length - 1].at,
    });
    counts[deal.stage.toLowerCase()] = (counts[deal.stage.toLowerCase()] ?? 0) + 1;
    for (const h of timeline) {
      if (!h.by.email) {
        feedRuns.set(h.day, (feedRuns.get(h.day) ?? 0) + 1);
        continue;
      }
      stageChanges++;
      audit.push({
        at: h.at,
        actorEmail: h.by.email,
        actorRole: h.by.role,
        action: DEAL_STAGE_CHANGE,
        entityType: "deal",
        entityId: id,
        detail: JSON.stringify({ from: h.from, to: h.stage }),
      });
    }
  }

  for (const [day, upserted] of [...feedRuns].sort(([a], [b]) => a.localeCompare(b))) {
    audit.push({
      at: ctx.at(day, `crm-deals:${day}`),
      actorEmail: null,
      actorRole: "INGEST",
      action: INGEST_DEALS,
      entityType: "ingest_run",
      entityId: demoUuid(`crm-deals:${day}`),
      detail: JSON.stringify({ source: "crm-deals", endpoint: "deals", received: upserted, upserted, rejected: 0, dry_run: false }),
    });
  }

  // The deals in one statement and their audit rows in another, each in the order the one-at-a-time writes made, so
  // the row-change trail and the audit log number them as before.
  await ctx.owner.deal.createMany({ data: rows });
  await ctx.owner.auditLog.createMany({ data: audit });
  ctx.shared.deals = { ids: new Map(deals.map((d) => [d.sfDealId, dealId(d.sfDealId)])) };

  return { ...counts, stageChanges, crmRuns: feedRuns.size };
}
