import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readAcatCandidatesWithinScope } from "@/lib/data/acat-match-source";

vi.mock("server-only", () => ({}));

const RUN = process.env.ACAT_SCHEMA_COMPATIBILITY_TEST_OWNER_URL ? describe : describe.skip;
const rollback = new Error("synthetic_schema_compatibility_rollback");

RUN("ACAT evidence before and after funding-plan schema rollout", () => {
  let owner: PrismaClient;
  let originalColumnPresent: boolean;
  beforeAll(async () => {
    const url = new URL(process.env.ACAT_SCHEMA_COMPATIBILITY_TEST_OWNER_URL!);
    if (!["postgresql:", "postgres:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
      || url.port !== "15542" || !["/aoa_acat_reconciliation_synthetic", "/aoa_acat_main_release_synthetic"].includes(url.pathname) || url.username !== "aoa"
      || url.hash || [...url.searchParams.keys()].some((key) => key !== "schema")
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
      throw new Error("isolated_acat_schema_compatibility_database_required");
    }
    owner = new PrismaClient({ datasourceUrl: url.href });
    const [actual] = await owner.$queryRaw<Array<{ database: string; username: string }>>`
      SELECT current_database() AS database, current_user AS username`;
    expect(actual).toEqual({ database: url.pathname.slice(1), username: "aoa" });
    originalColumnPresent = await columnPresent();
  });
  afterAll(async () => { await owner?.$disconnect(); });

  async function columnPresent() {
    const [column] = await owner.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='app'
        AND table_name='transfer' AND column_name='funding_plan_version') AS present`;
    return column.present;
  }

  async function rollBackEveryChange(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
    try {
      await owner.$transaction(async (tx) => { await fn(tx); throw rollback; }, { timeout: 10_000 });
    } catch (error) { if (error !== rollback) throw error; }
  }

  it.each([true, false])("reads and fences transfers with funding-plan column present=%s", async (present) => {
    const id = `ZZTEST-ACAT-SCHEMA-COMPATIBILITY-${present ? "PRESENT" : "ABSENT"}`;
    await rollBackEveryChange(async (tx) => {
      await tx.$executeRaw`INSERT INTO app.transfer(id,source,client_first_name,client_last_name,value,updated_at)
        VALUES(${id},'APP','Synthetic','Schema compatibility',1,CURRENT_TIMESTAMP)`;
      if (present && !originalColumnPresent) {
        await tx.$executeRawUnsafe("ALTER TABLE app.transfer ADD COLUMN funding_plan_version integer NOT NULL DEFAULT 0");
      } else if (!present && originalColumnPresent) {
        await tx.$executeRawUnsafe("ALTER TABLE app.transfer DROP COLUMN funding_plan_version");
      }
      await tx.$executeRaw`SELECT set_config('app.user_role','OPERATIONS',true),
        set_config('app.user_email','synthetic-schema-compatibility@example.invalid',true)`;
      await tx.$executeRawUnsafe("SET LOCAL ROLE app_rw");
      const [role] = await tx.$queryRaw<Array<{ username: string; superuser: boolean; bypassrls: boolean }>>`
        SELECT current_user AS username, rolsuper AS superuser, rolbypassrls AS bypassrls
        FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({ username: "app_rw", superuser: false, bypassrls: false });
      const read = async () => (await readAcatCandidatesWithinScope(tx)).find((row) => row.transferId === id)!;
      const original = await read(); expect(original.linkVersion).toBe(0);
      if (present) await tx.$executeRaw`UPDATE app.transfer SET funding_plan_version=1 WHERE id=${id}`;
      else await tx.$executeRaw`UPDATE app.transfer SET stage='IN_TRANSFER' WHERE id=${id}`;
      const changed = await read();
      expect(changed.linkVersion).toBe(1); expect(changed.evidenceDigest).not.toBe(original.evidenceDigest);
      await tx.$executeRaw`UPDATE app.transfer SET next_step='Synthetic unrelated edit' WHERE id=${id}`;
      expect(await read()).toEqual(changed);
      await tx.$executeRaw`UPDATE app.transfer SET acat_record_id='synthetic-record' WHERE id=${id}`;
      await tx.$executeRaw`UPDATE app.transfer SET acat_record_id=NULL WHERE id=${id}`;
      expect(await read()).toMatchObject({ linkVersion: 3, hold: true, existingRecordId: null });
    });
    expect(await owner.transfer.count({ where: { id } })).toBe(0);
    expect(await columnPresent()).toBe(originalColumnPresent);
  });
});
