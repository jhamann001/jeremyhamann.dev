import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { getHouseholdDirectory, getHouseholdDirectoryPreview } from "@/lib/data/households";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS } from "@/lib/navigation/household-query";

function isIsolatedSyntheticDatabase(): boolean {
  const cleanupUrl = process.env.AUDIT_TEST_CLEANUP_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!process.env.AUDIT_TEST_DB_URL || !cleanupUrl || !appUrl ||
    process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE) return false;

  try {
    const parsed = new URL(cleanupUrl);
    const appParsed = new URL(appUrl);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
      ["5432", "55444"].includes(parsed.port) && parsed.username === "aoa" &&
      ["/aoa_loading_full_synthetic", "/aoa_pagination_synthetic"].includes(parsed.pathname) &&
      appParsed.hostname === parsed.hostname && appParsed.port === parsed.port &&
      appParsed.pathname === parsed.pathname && appParsed.username === "app_rw";
  } catch {
    return false;
  }
}

const gated = isIsolatedSyntheticDatabase() ? describe : describe.skip;
const OWNER_EMAIL = "preview-owner@example.invalid";
const OTHER_EMAIL = "preview-other@example.invalid";
const NORMALIZED_FIRST_ID = "001PRV000000000AAA";

gated("Households first-page preview uses the same RLS-visible order", () => {
  let owner: PrismaClient;

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL!;
    owner = new PrismaClient({ datasourceUrl: url });
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = '003PRV000000000AAA'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001PRV%'`;
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, status, stage, lead_advisor_email)
      SELECT '001PRV' || lpad(i::text, 9, '0') || 'AAA',
             'AAA Preview Synthetic ' || lpad(i::text, 4, '0'),
             'Active', CASE WHEN i <= 110 THEN 'Client' ELSE 'Prospect' END,
             CASE WHEN i <= 115 THEN ${OWNER_EMAIL} ELSE ${OTHER_EMAIL} END
        FROM generate_series(1, 120) i`;
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, status, stage, lead_advisor_email)
      VALUES (${NORMALIZED_FIRST_ID}, 'The A Household', 'Active', 'Client', ${OWNER_EMAIL})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES ('003PRV000000000AAA', ${NORMALIZED_FIRST_ID}, 'Alex', 'A', ${OWNER_EMAIL})`;
  });
  afterAll(async () => {
    if (owner) {
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = '003PRV000000000AAA'`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001PRV%'`;
      await owner.$disconnect();
    }
    vi.unstubAllEnvs();
  });

  it("matches the exact default first page for an advisor and operations", async () => {
    for (const canonicalReads of ["0", "1"]) {
      vi.stubEnv("CRM_IDENTITY_READS", canonicalReads);
      for (const identity of [
        { role: "ADVISOR", email: OWNER_EMAIL },
        { role: "OPERATIONS", email: OWNER_EMAIL },
      ]) {
        const preview = await getHouseholdDirectoryPreview(identity);
        const exact = await getHouseholdDirectory(identity, DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
        expect(preview.map((row) => row.sf_id)).toEqual(exact.rows.map((row) => row.sf_id));
        expect(preview.map((row) => row.name)).toEqual(exact.rows.map((row) => row.name));
        expect(preview).toHaveLength(100);
        expect(preview[0]).toMatchObject({ sf_id: NORMALIZED_FIRST_ID, name: "A Household" });
        if (identity.role === "ADVISOR") {
          expect(preview.every((row) => row.lead_advisor_email === OWNER_EMAIL)).toBe(true);
        }
      }
    }
  });

  it("does not expose any households to a viewer", async () => {
    expect(await getHouseholdDirectoryPreview({ role: "VIEWER", email: OWNER_EMAIL })).toEqual([]);
  });
});
