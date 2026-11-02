import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORD_KINDS } from "@/lib/trade-requests/records/catalog";
import { SRC_DB, TGT_DB, createDatabases, dropDatabases, enabled, psql } from "./trade-request-copy-db";

const suite = enabled ? describe : describe.skip;

function columnsOf(db: string, schema: string, table: string): string[] {
  const out = psql(
    db,
    `SELECT string_agg(column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, ''), E'\\n' ORDER BY column_name)
       FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}'`,
  );
  return out.split("\n").map((line) => line.replace("uuid_generate_v4()", "gen_random_uuid()"));
}

function primaryKeyOf(db: string, schema: string, table: string): string[] {
  const out = psql(
    db,
    `SELECT string_agg(k.column_name, ',' ORDER BY k.ordinal_position)
       FROM information_schema.table_constraints c
       JOIN information_schema.key_column_usage k
         ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema AND k.table_name = c.table_name
      WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = '${schema}' AND c.table_name = '${table}'`,
  );
  return out.split(",");
}

suite("Trade Request schema parity (scratch databases)", () => {
  beforeAll(async () => {
    await createDatabases();
  }, 300_000);

  afterAll(() => dropDatabases(), 120_000);

  it("1: every record table has the standalone service's columns, types, nullability and defaults", () => {
    for (const { table } of RECORD_KINDS) {
      const target = columnsOf(TGT_DB, "trade_request", table);
      expect(target.length, table).toBeGreaterThan(1);
      expect(target, table).toEqual(columnsOf(SRC_DB, "public", table));
    }
  });

  it("2: every record table's primary key equals the catalog key", () => {
    for (const kind of RECORD_KINDS) expect(primaryKeyOf(TGT_DB, "trade_request", kind.table), kind.table).toEqual([...kind.key]);
  });
});
