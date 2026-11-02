import "server-only";
import { prisma } from "@/lib/db";
import type { NativeActor } from "@/lib/trade-requests/native/registry";
import { NativeHttpError, SEGMENT, SERVICE_PARSE, bodyOf, nativeRoutes, route, type NativeResponse } from "@/lib/trade-requests/native/reads/http";
import { emitTradeRequestEvent } from "@/lib/trade-requests/native/side-effects";
import type { TradeRequestCall } from "@/lib/trade-requests/client";
import { batchBodySchema, clientIdParamSchema } from "./exclusion-schemas";
import { actingUser, aoaWrite, pgCode, refusable, type Tx, type WriteUser } from "./support";

// Exclusion batch saves (the Manage dialog's Apply), ported from trade-request d41b6c9
// server/src/routes/exclusions.ts:164-190 (row mappers), :359-494 (account batch), :510-722 (client batch)
// and :897-904 (client name). Removes, then edits, then adds, in one transaction; any failure writes nothing.

type Kind = "advisor" | "client";
type Row = { id: string; entity_id: string; ticker: string; kind: Kind; reason: string; no_buy: boolean; no_sell: boolean; created_by_name: string; created_at: Date };
type Entry = { ticker: string; kind: Kind; reason: string; noBuy: boolean; noSell: boolean };
type Change = { ticker: string; kind: Kind; before: { noBuy: boolean; noSell: boolean }; after: { noBuy: boolean; noSell: boolean } };
type Scope = { table: "client_exclusions" | "account_exclusions"; key: "client_id" | "account_id"; field: "clientId" | "accountId"; noun: "client" | "account" };

const CLIENT: Scope = { table: "client_exclusions", key: "client_id", field: "clientId", noun: "client" };
const ACCOUNT: Scope = { table: "account_exclusions", key: "account_id", field: "accountId", noun: "account" };

const columns = (s: Scope) =>
  `id::text AS id, ${s.key} AS entity_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at FROM trade_request.${s.table}`;

function toExclusion(s: Scope, row: Row) {
  return {
    id: row.id,
    [s.field]: row.entity_id,
    ticker: row.ticker,
    kind: row.kind,
    reason: row.reason,
    noBuy: row.no_buy,
    noSell: row.no_sell,
    createdByName: row.created_by_name,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  };
}

async function applyBatch(tx: Tx, s: Scope, entityId: string, user: WriteUser, body: ReturnType<typeof batchBodySchema.parse>) {
  const removed: Entry[] = [];
  const added: Entry[] = [];
  const changed: Change[] = [];
  const one = async (id: string) => {
    const rows = await tx.$queryRawUnsafe<Row[]>(`SELECT ${columns(s)} WHERE id = $1::uuid AND ${s.key} = $2`, id, entityId);
    if (rows.length === 0) throw new NativeHttpError(404, `Exclusion ${id} not found for this ${s.noun}`);
    return rows[0];
  };
  for (const removeId of body.remove) {
    const target = await one(removeId);
    await tx.$executeRawUnsafe(`DELETE FROM trade_request.${s.table} WHERE id = $1::uuid`, removeId);
    removed.push({ ticker: target.ticker, kind: target.kind, reason: target.reason, noBuy: target.no_buy, noSell: target.no_sell });
  }
  for (const edit of body.edit) {
    const target = await one(edit.id);
    try {
      await tx.$executeRawUnsafe(`UPDATE trade_request.${s.table} SET no_buy = $1::boolean, no_sell = $2::boolean WHERE id = $3::uuid`, edit.noBuy, edit.noSell, edit.id);
    } catch (err) {
      if (pgCode(err) === "23514") throw new NativeHttpError(400, `Exclusion ${edit.id}: at least one of noBuy or noSell must be true`);
      throw err;
    }
    if (target.no_buy !== edit.noBuy || target.no_sell !== edit.noSell) {
      changed.push({ ticker: target.ticker, kind: target.kind, before: { noBuy: target.no_buy, noSell: target.no_sell }, after: { noBuy: edit.noBuy, noSell: edit.noSell } });
    }
  }
  for (const add of body.add) {
    try {
      await tx.$executeRawUnsafe(
        `INSERT INTO trade_request.${s.table} (${s.key}, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name)
         VALUES ($1, $2, $3, $4, $5::boolean, $6::boolean, $7::uuid, $8)`,
        entityId, add.ticker, add.kind, add.reason, add.noBuy, add.noSell, user.id, user.name,
      );
    } catch (err) {
      if (pgCode(err) === "23505") throw new NativeHttpError(409, `${add.ticker} is already on the ${add.kind} exclusion list for this ${s.noun}.`);
      throw err;
    }
    added.push({ ticker: add.ticker, kind: add.kind, reason: add.reason, noBuy: add.noBuy, noSell: add.noSell });
  }
  const rows = await tx.$queryRawUnsafe<Row[]>(`SELECT ${columns(s)} WHERE ${s.key} = $1 ORDER BY kind, ticker`, entityId);
  return { removed, added, changed, list: rows.map((row) => toExclusion(s, row)) };
}

/** Best-effort name for notifications: the copied clients table, else the id (exclusions.ts:897-904). */
async function resolveClientName(clientId: string): Promise<string> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM trade_request.clients WHERE id = $1", clientId);
    return rows[0]?.name ?? clientId;
  } catch {
    return clientId;
  }
}

async function save(s: Scope, rawId: string, call: TradeRequestCall, actor: NativeActor): Promise<NativeResponse> {
  const user = await actingUser(actor);
  const entityId = clientIdParamSchema.parse(rawId);
  const body = batchBodySchema.parse(bodyOf(call), SERVICE_PARSE);
  const result = await aoaWrite((tx) => applyBatch(tx, s, entityId, user, body));
  // The account route counts edits that changed a flag and sends no notification (exclusions.ts:435, :483-490).
  if (s === CLIENT && result.added.length + result.removed.length + result.changed.length > 0) {
    const clientName = await resolveClientName(entityId);
    void emitTradeRequestEvent({
      kind: "exclusion_batch_changed",
      batch: { clientName, added: result.added, removed: result.removed, changed: result.changed, changedBy: user.name },
      clientId: entityId,
    });
  }
  return {
    status: 200,
    body: { data: { exclusions: result.list, added: result.added.length, removed: result.removed.length, edited: result.changed.length } },
  };
}

export const exclusionSave = nativeRoutes(
  route("POST", `/clients/account-exclusions/${SEGMENT}/batch`, refusable(([id], call, actor) => save(ACCOUNT, id, call, actor))),
  route("POST", `/clients/${SEGMENT}/exclusions/batch`, refusable(([id], call, actor) => save(CLIENT, id, call, actor))),
);
