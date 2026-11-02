import { withUserScope, type Identity } from "@/lib/rls";
import type { TaxBudget } from "@/lib/data/types";

type TaxBudgetRow = {
  year: number;
  budget: unknown;
  realized: unknown;
  note: string;
};

/** The active tax year follows the server's calendar year. */
export function currentTaxYear(now = new Date()): number {
  return now.getUTCFullYear();
}

/**
 * Read the active budget and most recent earlier budget for one client.
 *
 * app.tax_budget's policy checks visibility through mirror.client, so this
 * cannot widen the caller's book. An unknown/out-of-book client produces the
 * same empty result as a client with no stored budget.
 */
export async function taxBudgetForClient(
  identity: Identity,
  clientSfId: string,
  year = currentTaxYear(),
): Promise<TaxBudget> {
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<TaxBudgetRow[]>`
      SELECT year, budget, realized, note
      FROM app.tax_budget
      WHERE client_sf_id = ${clientSfId}
        AND year <= ${year}
      ORDER BY year DESC
      LIMIT 2`,
  );

  const current = rows.find((row) => row.year === year) ?? null;
  const prior = rows.find((row) => row.year < year) ?? null;

  return {
    year,
    current: current
      ? {
          budget: Number(current.budget),
          realized: Number(current.realized),
          note: current.note,
        }
      : null,
    prior: prior
      ? {
          year: prior.year,
          budget: Number(prior.budget),
        }
      : null,
  };
}
