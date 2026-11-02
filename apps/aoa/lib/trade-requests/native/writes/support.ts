import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveActorIdentity } from "@/lib/trade-requests/identity";
import { standaloneRole, type NativeActor } from "@/lib/trade-requests/native/registry";
import type { NativeResponse, NativeRoute } from "@/lib/trade-requests/native/reads/http";

// Shared by the native write handlers (ticket). Routing, the standalone error
// handler and the result mapping are ticket's (native/reads/http.ts). Every
// table is named trade_request.<table>; logs carry an event and a code, never values.

export type Tx = Prisma.TransactionClient;

/** The standalone service's req.user on /api/aoa: identity id and stored name, role mapped from the current AOA role. */
export type WriteUser = { id: string; name: string; role: "trader" | "advisor" };

/** Trade Requests are not AOA-served: the transaction stops before its first write. */
export class WriteRefused extends Error {
  constructor() {
    super("trade_request_native_write_refused");
    this.name = "WriteRefused";
  }
}

export const STALE_MESSAGE = "Request was modified by another user. Please refresh and try again.";
export const AUDIT_INSERT_SQL = `INSERT INTO trade_request.audit_logs (request_id, user_name, user_id, action, notes, channel)
  VALUES ($1, $2, $3::uuid, $4, $5, 'aoa')`;

// The serving-state writer (ticket) takes this key exclusively while it switches, so a write never straddles a switch.
const SERVING_LOCK_SQL = "SELECT pg_advisory_xact_lock_shared(hashtext('trade_request.serving_state'))";
const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/** Runs `work` in one transaction that first confirms Trade Requests are AOA-served. Use only `tx` inside. */
export async function aoaWrite<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(SERVING_LOCK_SQL);
    const rows = await tx.$queryRawUnsafe<Array<{ serving_source: string }>>(
      "SELECT serving_source FROM trade_request.serving_state WHERE id",
    );
    if (rows[0]?.serving_source !== "aoa") throw new WriteRefused();
    // The extended client's tx has the vanilla TransactionClient shape; cast at this one boundary (lib/rls.ts:46-54).
    return work(tx as unknown as Tx);
  }, TX_OPTIONS);
}

/** The acting identity, resolved (and created for a first-time actor) under the serving check, as the standalone middleware does. */
export async function actingUser(actor: NativeActor): Promise<WriteUser> {
  const identity = await aoaWrite((tx) => resolveActorIdentity(tx, { email: actor.email, name: actor.name }));
  return { id: identity.id, name: identity.name ?? actor.name, role: standaloneRole(actor) };
}

/** Postgres SQLSTATE of a failed raw query (Prisma reports P2010 with meta.code), otherwise the Prisma code. */
export function pgCode(err: unknown): string | null {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  if (typeof e?.meta?.code === "string") return e.meta.code;
  return typeof e?.code === "string" ? e.code : null;
}

/** A refused write answers 503 with the call's own failure line; nothing falls back to the delegated path. */
export function refusable(run: NativeRoute["run"]): NativeRoute["run"] {
  return async (params, call, actor) => {
    try {
      return await run(params, call, actor);
    } catch (err) {
      if (!(err instanceof WriteRefused)) throw err;
      console.warn(JSON.stringify({ event: "trade_request_native_write_refused", operation: call.operation }));
      return { status: 503, body: { error: call.defaultMessage } };
    }
  };
}

/** requireRole('trader') (server/src/middleware/auth.ts:202-215). */
export const FORBIDDEN: NativeResponse = { status: 403, body: { error: "Insufficient permissions" } };
