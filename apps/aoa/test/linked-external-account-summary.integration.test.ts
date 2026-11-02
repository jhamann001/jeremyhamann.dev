import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { makeCleanupClient } from "./ingest/db-fixture";
import { linkedExternalSummariesForClient } from "@/lib/data/linked-external-account-summary";

const ADVISOR_A = "advisor-a@example.invalid";
const ADVISOR_B = "advisor-b@example.invalid";
const HH_A = "TPLAIDHHA000001";
const HH_B = "TPLAIDHHB000001";
const CLIENT_A = "TPLAIDCLA000001";
const CLIENT_B = "TPLAIDCLB000001";
const EXT_B = "TEST-PLAID-EXT-B";
const EXT_OLD = "TEST-PLAID-EXT-OLD";
const EXT_NEW = "TEST-PLAID-EXT-NEW";

const suite =
  process.env.INGEST_DATABASE_URL && process.env.DATABASE_URL && process.env.INGEST_TEST_CLEANUP_URL
    ? describe
    : describe.skip;

suite("linked_external_account_summary isolation and relink", () => {
  const cleanup = makeCleanupClient();

  beforeAll(async () => {
    await cleanup.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, status)
      VALUES
        (${HH_A}, 'Plaid Household A', ${ADVISOR_A}, 'Active'),
        (${HH_B}, 'Plaid Household B', ${ADVISOR_B}, 'Active')`;
    await cleanup.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, email, lead_advisor_email)
      VALUES
        (${CLIENT_A}, ${HH_A}, 'Ada', 'Alpha', 'ada-a@example.invalid', ${ADVISOR_A}),
        (${CLIENT_B}, ${HH_B}, 'Bea', 'Beta', 'bea-b@example.invalid', ${ADVISOR_B})`;
    await cleanup.$executeRaw`
      INSERT INTO mirror.linked_external_account_summary (
        external_account_id, client_sf_id, household_sf_id, institution_name,
        account_subtype, mask, cash_amount, securities_amount, holdings_total,
        institution_balance, as_of, link_status, lineage_key, prior_external_account_id
      ) VALUES
        (${EXT_B}, ${CLIENT_B}, ${HH_B}, 'Bank B', 'brokerage', '1111',
         10, 20, 30, 30, now(), 'ACTIVE', 'lineage-b', NULL),
        (${EXT_OLD}, ${CLIENT_A}, ${HH_A}, 'Bank A', 'brokerage', '2222',
         1, 2, 3, 3, now(), 'ACTIVE', 'lineage-relink', NULL)`;
    await cleanup.$executeRaw`
      INSERT INTO mirror.linked_external_account_summary (
        external_account_id, client_sf_id, household_sf_id, institution_name,
        account_subtype, mask, cash_amount, securities_amount, holdings_total,
        institution_balance, as_of, link_status, lineage_key, prior_external_account_id
      ) VALUES (
        ${EXT_NEW}, ${CLIENT_A}, ${HH_A}, 'Bank A', 'brokerage', '2222',
        4, 5, 9, 9, now(), 'ACTIVE', 'lineage-relink', ${EXT_OLD}
      )
      ON CONFLICT (external_account_id) DO UPDATE SET
        prior_external_account_id = EXCLUDED.prior_external_account_id,
        lineage_key = EXCLUDED.lineage_key,
        link_status = EXCLUDED.link_status,
        holdings_total = EXCLUDED.holdings_total,
        synced_at = now()`;
    await cleanup.$executeRaw`
      UPDATE mirror.linked_external_account_summary
      SET link_status = 'inactive', synced_at = now()
      WHERE external_account_id = ${EXT_OLD}`;
  });

  afterAll(async () => {
    await cleanup.$executeRaw`
      DELETE FROM mirror.linked_external_account_summary
      WHERE external_account_id LIKE 'TEST-PLAID-%'`;
    await cleanup.$executeRaw`
      DELETE FROM mirror.client WHERE sf_id LIKE 'TPLAIDCL%'`;
    await cleanup.$executeRaw`
      DELETE FROM mirror.household WHERE sf_id LIKE 'TPLAIDHH%'`;
    await cleanup.$disconnect();
  });

  it("Advisor A cannot read Advisor B client summaries (isolation)", async () => {
    const own = await linkedExternalSummariesForClient(
      { role: "ADVISOR", email: ADVISOR_B },
      CLIENT_B,
    );
    expect(own.map((row) => row.externalAccountId)).toContain(EXT_B);
    const cross = await linkedExternalSummariesForClient(
      { role: "ADVISOR", email: ADVISOR_A },
      CLIENT_B,
    );
    const crossBookRows = cross.length;
    expect(`crossBookRows=${crossBookRows}`).toBe("crossBookRows=0");
  });

  it("relink keeps priorExternalAccountId on the new active row", async () => {
    const rows = await linkedExternalSummariesForClient(
      { role: "ADVISOR", email: ADVISOR_A },
      CLIENT_A,
    );
    const relinked = rows.find((row) => row.externalAccountId === EXT_NEW);
    expect(relinked?.linkStatus).toBe("ACTIVE");
    expect(relinked?.lineageKey).toBe("lineage-relink");
    expect(`priorExternalAccountId=${relinked?.priorExternalAccountId}`).toBe(
      "priorExternalAccountId=TEST-PLAID-EXT-OLD",
    );
    expect(rows.some((row) => row.externalAccountId === EXT_OLD)).toBe(false);
  });
});
