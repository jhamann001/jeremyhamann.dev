// Demo seed part: each client's realized-gains budget for the tax year the seed runs in, and last year's for clients
// who were with the firm then, as the lead advisor sets them on the Client Portrait's Tax Budget card
// (app/(authenticated)/client-portrait/[id]/actions.ts), with the audit row that action writes. The showcase clients'
// budgets and notes are written in lib/demo/samples/showcase.ts; everyone else's follow their taxable assets.

import type { Prisma } from "@prisma/client";
import { TAX_BUDGET_SET } from "@/lib/audit";
import { currentTaxYear } from "@/lib/data/tax-budget";
import { planTaxBudgets } from "../samples/build";
import { addCalendarDays } from "./calendar";
import type { SeedContext } from "./context";
import { staffUserId } from "./people";
import { demoCuid, seededInt, staffEmail, staffOf } from "./universe";

export async function seedPlanning(ctx: SeedContext): Promise<Record<string, number>> {
  const { universe, owner, now, today } = ctx;
  const year = currentTaxYear(now);
  const budgets: Prisma.TaxBudgetRecordCreateManyInput[] = [];
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  for (const plan of planTaxBudgets(universe)) {
    const person = universe.people.find((p) => p.id === plan.person)!;
    const advisor = staffOf(universe, universe.households.find((h) => h.id === person.household)!.advisor);
    const clientSfId = ctx.personId.get(person.id)!;
    const setAt = ctx.at(addCalendarDays(today, -seededInt(`${person.id}:tax:set`, 20, 280)), `${person.id}:tax`);
    const years = [{ year, budget: plan.budget, realized: plan.realized, note: plan.note, at: setAt }];
    if (plan.prior != null) {
      const realized = Math.round(plan.prior * (0.4 + seededInt(`${person.id}:tax:prior`, 0, 55) / 100));
      years.push({ year: year - 1, budget: plan.prior, realized, note: "", at: new Date(setAt.getTime() - 365 * 86_400_000) });
    }
    for (const y of years) {
      // Derived from the client and year (one budget each), so a reset rebuilds the same id.
      const id = demoCuid(`tax-budget:${clientSfId}:${y.year}`);
      budgets.push({
        id, client_sf_id: clientSfId, year: y.year, budget: y.budget, realized: y.realized, note: y.note,
        set_by: staffEmail(advisor), created_at: y.at, updated_at: y.at,
      });
      audit.push({
        at: y.at, actorId: staffUserId(advisor.id), actorEmail: staffEmail(advisor), actorRole: "ADVISOR",
        action: TAX_BUDGET_SET, entityType: "tax_budget", entityId: id,
        detail: JSON.stringify({ clientSfId, year: y.year, budget: y.budget, realized: y.realized, notePresent: y.note !== "" }),
      });
    }
  }
  // The budgets in one statement and their audit rows in another, each in the order the one-at-a-time writes made, so
  // the row-change trail and the audit log number them as before.
  await owner.taxBudgetRecord.createMany({ data: budgets });
  await owner.auditLog.createMany({ data: audit });
  return { taxBudgets: budgets.length };
}
