import { Prisma, type PrismaClient } from "@prisma/client";
import { RECORD_KINDS, type RecordKind } from "./catalog";

export type CopyMode = "full" | "change" | "report" | "copy_back";
export type KindResult = { table: string; fromCount: number; toCount: number; missing: number; differing: number; extra: number };
export type CopyResult = { runId: string; mode: CopyMode; verdict: "passed" | "blocked" | "report_only"; kinds: KindResult[] };
/** Test seams: drop or alter rows just before they are inserted, or shrink the read page. */
export type CopyHooks = { beforeInsert?: (table: string, rows: string[]) => string[]; readPage?: number };

type Tx = Prisma.TransactionClient;
type Side = { db: PrismaClient; schema: string };
type Hashes = Map<string, Map<string, string>>;

const TX_OPTIONS = {
  timeout: 30 * 60_000,
  maxWait: 60_000,
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
} as const;
const BATCH = 500;
/** Rows read per query. A whole production table as one result exceeds V8's maximum string length (about 537M characters). */
const READ_PAGE = 1000;
const CATALOG = RECORD_KINDS.map((k) => k.table);

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const keyExpr = (kind: RecordKind, alias: string) => kind.key.map((k) => `${alias}.${q(k)}::text`).join(` || '|' || `);
const rel = (side: Side, kind: RecordKind) => `${q(side.schema)}.${q(kind.table)}`;

/** Every transaction renders timestamps in UTC so both databases hash identically. */
async function utc(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
}

async function hashes(tx: Tx, side: Side, kind: RecordKind): Promise<Map<string, string>> {
  const minus = kind.standaloneOnly.map((c) => ` - '${c}'`).join("");
  const rows = await tx.$queryRawUnsafe<Array<{ k: string; h: string }>>(
    `SELECT ${keyExpr(kind, "t")} AS k, md5((to_jsonb(t)${minus})::text) AS h FROM ${rel(side, kind)} t`,
  );
  return new Map(rows.map((r) => [r.k, r.h]));
}

async function allHashes(tx: Tx, side: Side): Promise<Hashes> {
  const out: Hashes = new Map();
  for (const kind of RECORD_KINDS) out.set(kind.table, await hashes(tx, side, kind));
  return out;
}

/** Rows as JSON text (no JavaScript number conversion), read `page` keys at a time. */
async function rowTexts(tx: Tx, side: Side, kind: RecordKind, keys: string[], page: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += page) {
    const rows = await tx.$queryRawUnsafe<Array<{ k: string; j: string }>>(
      `SELECT ${keyExpr(kind, "t")} AS k, to_jsonb(t)::text AS j FROM ${rel(side, kind)} t WHERE ${keyExpr(kind, "t")} = ANY($1::text[])`,
      keys.slice(i, i + page),
    );
    for (const r of rows) out.set(r.k, r.j);
  }
  return out;
}

async function insertRows(tx: Tx, side: Side, kind: RecordKind, texts: string[]): Promise<void> {
  for (let i = 0; i < texts.length; i += BATCH) {
    await tx.$executeRawUnsafe(
      `INSERT INTO ${rel(side, kind)} SELECT * FROM jsonb_populate_recordset(NULL::${rel(side, kind)}, $1::jsonb)`,
      `[${texts.slice(i, i + BATCH).join(",")}]`,
    );
  }
}

async function updateRows(tx: Tx, side: Side, kind: RecordKind, cols: string[], texts: string[], keepStandaloneOnly: boolean): Promise<void> {
  const set = cols.filter((c) => !kind.key.includes(c) && !(keepStandaloneOnly && kind.standaloneOnly.includes(c)));
  if (set.length === 0 || texts.length === 0) return;
  const join = kind.key.map((k) => `t.${q(k)} = s.${q(k)}`).join(" AND ");
  for (let i = 0; i < texts.length; i += BATCH) {
    await tx.$executeRawUnsafe(
      `UPDATE ${rel(side, kind)} t SET (${set.map(q).join(", ")}) = (${set.map((c) => `s.${q(c)}`).join(", ")})
         FROM jsonb_populate_recordset(NULL::${rel(side, kind)}, $1::jsonb) s WHERE ${join}`,
      `[${texts.slice(i, i + BATCH).join(",")}]`,
    );
  }
}

async function deleteKeys(tx: Tx, side: Side, kind: RecordKind, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await tx.$executeRawUnsafe(`DELETE FROM ${rel(side, kind)} t WHERE ${keyExpr(kind, "t")} = ANY($1::text[])`, keys);
}

async function columns(tx: Tx, side: Side, kind: RecordKind): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${side.schema} AND table_name = ${kind.table} ORDER BY ordinal_position`;
  return rows.map((r) => r.column_name);
}

/** Foreign keys from a table outside the catalog to a catalog table, except references to kinds never deleted on that side. */
async function foreignReferences(tx: Tx, side: Side, protectedTables: string[]): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ child: string; parent: string }>>`
    SELECT cn.nspname || '.' || ch.relname AS child, p.relname AS parent
      FROM pg_constraint c
      JOIN pg_class p ON p.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      JOIN pg_class ch ON ch.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = ch.relnamespace
     WHERE c.contype = 'f' AND pn.nspname = ${side.schema} AND p.relname = ANY(${CATALOG})
       AND NOT (cn.nspname = ${side.schema} AND ch.relname = ANY(${CATALOG}))`;
  return rows.filter((r) => !protectedTables.includes(r.parent)).map((r) => `${r.child} -> ${r.parent}`);
}

function compare(from: Hashes, to: Hashes, mode: CopyMode): KindResult[] {
  return RECORD_KINDS.map((kind) => {
    const f = from.get(kind.table)!;
    const t = to.get(kind.table)!;
    let missing = 0;
    let differing = 0;
    let extra = 0;
    for (const [k, h] of f) {
      const th = t.get(k);
      if (th === undefined) missing++;
      else if (th !== h) differing++;
    }
    if (!(mode === "copy_back" && kind.neverDeleteOnCopyBack)) for (const k of t.keys()) if (!f.has(k)) extra++;
    return { table: kind.table, fromCount: f.size, toCount: t.size, missing, differing, extra };
  });
}

export async function runCopy(opts: {
  source: PrismaClient;
  target: PrismaClient;
  mode: CopyMode;
  actor: string;
  hooks?: CopyHooks;
}): Promise<CopyResult> {
  const { source, target, mode, actor, hooks } = opts;
  const state = await target.$queryRaw<Array<ServingRow>>`
    SELECT serving_source, digest_sender, drift_sender FROM trade_request.serving_state WHERE id`;
  const servingSource = state[0]?.serving_source ?? "standalone";
  const [run] = await target.$queryRaw<Array<{ id: string }>>`
    INSERT INTO trade_request.copy_runs (mode, actor, serving_source_at_start)
    VALUES (${mode}, ${actor}, ${servingSource}) RETURNING id::text AS id`;
  try {
    const refusal =
      writeRefusal(mode, state[0]) ??
      (mode === "copy_back" ? await copyBackRefusal(target) : mode === "report" ? null : await forwardTransitionRefusal(target, mode));
    if (refusal) throw new CopyRefused(refusal);
    const result = await execute(source, target, mode, hooks, run.id);
    return result;
  } catch (err) {
    // Only our own refusal text or a database error code is stored: never a message that could echo a value.
    const refused = err instanceof CopyRefused;
    const code = refused ? err.message : `failed:${(err as { code?: unknown })?.code ?? "unknown"}`;
    await target.$executeRaw`
      UPDATE trade_request.copy_runs SET finished_at = NOW(), verdict = ${refused ? "refused" : "failed"}, error = ${code}
       WHERE id = ${run.id}::uuid`;
    throw err;
  }
}

type ServingRow = { serving_source: string; digest_sender: string; drift_sender: string };

export class CopyRefused extends Error {}

/**
 * Forward copies (full, change) overwrite AOA's records, so they run only while every field is standalone: after a
 * rollback the senders can stay AOA until 10:00 (epic AC-95, AC-97) and AOA still writes digest and drift claims.
 * Copy-back runs only while the service is standalone-served (epic AC-80) and only after a passed forward copy (`copyBackRefusal`). Report runs always.
 */
export function writeRefusal(mode: CopyMode, row: ServingRow | undefined): string | null {
  if (mode === "report") return null;
  const s = row ?? { serving_source: "standalone", digest_sender: "standalone", drift_sender: "standalone" };
  if (mode === "copy_back") return s.serving_source === "standalone" ? null : "copy_back copy requires serving_source=standalone";
  const allStandalone = s.serving_source === "standalone" && s.digest_sender === "standalone" && s.drift_sender === "standalone";
  return allStandalone ? null : `${mode} copy requires serving_source, digest_sender and drift_sender=standalone`;
}

/**
 * Copy-back mirrors AOA onto the standalone database, deletions included, so it runs only after a forward copy into
 * this AOA database has passed: an empty or wrong AOA side can never wipe the standalone records. Only forward runs
 * that could have written count (passed or blocked); refused and failed runs wrote nothing, so a stray refused attempt
 * after the cutover can never block the rollback. It also needs a serving-state transition after that forward copy:
 * only then has AOA served, so only then is AOA the newer side.
 */
async function copyBackRefusal(target: PrismaClient): Promise<string | null> {
  const rows = await target.$queryRaw<Array<{ verdict: string | null; transitioned: boolean }>>`
    SELECT r.verdict,
           EXISTS (SELECT 1 FROM trade_request.serving_state_transitions t WHERE t.at > r.started_at) AS transitioned
      FROM trade_request.copy_runs r
     WHERE r.mode IN ('full', 'change') AND r.verdict IN ('passed', 'blocked')
     ORDER BY r.started_at DESC LIMIT 1`;
  if (rows[0]?.verdict !== "passed") return "copy_back copy requires a passed full or change copy into this database";
  return rows[0].transitioned ? null : "copy_back copy requires a serving-state transition after the last full or change copy";
}

/**
 * Forward copies overwrite AOA's records, so they refuse while AOA may hold records not yet copied back: any
 * change of the serving source after the last passed copy-back (or any at all, if none has passed). AOA writes
 * records natively only while it serves (ticket), and every AOA-served period begins and ends with a change of
 * serving_source, so a sender-only transition (ticket's sender returns after a rollback) never leaves records
 * uncopied and is ignored. A row is ignored only when both states positively carry an equal servingSource; any
 * other shape counts, so the guard fails closed. The transitions table is written only by the cutover controller
 * (ticket), so this is inert until the first cutover.
 */
export async function forwardTransitionRefusal(db: PrismaClient | Tx, mode: CopyMode): Promise<string | null> {
  const [row] = await db.$queryRaw<Array<{ newer: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM trade_request.serving_state_transitions t
       WHERE t.at > COALESCE(
         (SELECT max(started_at) FROM trade_request.copy_runs WHERE mode = 'copy_back' AND verdict = 'passed'),
         '-infinity'::timestamptz)
         AND NOT (t.from_state ? 'servingSource' AND t.to_state ? 'servingSource'
                  AND t.from_state->>'servingSource' = t.to_state->>'servingSource')
    ) AS newer`;
  return row?.newer ? `${mode} copy requires a passed copy_back after the last serving-state transition` : null;
}

async function execute(source: PrismaClient, target: PrismaClient, mode: CopyMode, hooks: CopyHooks | undefined, runId: string): Promise<CopyResult> {
  const back = mode === "copy_back";
  const from: Side = back ? { db: target, schema: "trade_request" } : { db: source, schema: "public" };
  const to: Side = back ? { db: source, schema: "public" } : { db: target, schema: "trade_request" };

  // 1. To-side hashes before writing (decides which from-side rows to read).
  const toBefore = await to.db.$transaction(async (tx) => {
    await utc(tx);
    return allHashes(tx, to);
  }, TX_OPTIONS);

  // 2. One consistent from-side snapshot: hashes plus the rows that must be written.
  const snapshot = await from.db.$transaction(async (tx) => {
    await utc(tx);
    const h = await allHashes(tx, from);
    const rows = new Map<string, Map<string, string>>();
    if (mode !== "report") {
      for (const kind of RECORD_KINDS) {
        const f = h.get(kind.table)!;
        const t = toBefore.get(kind.table)!;
        const keys = mode === "full" ? [...f.keys()] : [...f].filter(([k, v]) => t.get(k) !== v).map(([k]) => k);
        rows.set(kind.table, await rowTexts(tx, from, kind, keys, hooks?.readPage ?? READ_PAGE));
      }
    }
    return { h, rows };
  }, TX_OPTIONS);

  let kinds: KindResult[];
  if (mode === "report") {
    kinds = compare(snapshot.h, toBefore, mode);
  } else {
    // 3. All writes and the verification in one to-side transaction.
    kinds = await to.db.$transaction(async (tx) => {
      await utc(tx);
      const fks = await foreignReferences(tx, to, back ? RECORD_KINDS.filter((k) => k.neverDeleteOnCopyBack).map((k) => k.table) : []);
      if (fks.length > 0) throw new CopyRefused(`non-catalog foreign key: ${fks.join(", ")}`);
      if (!back) {
        const [s] = await tx.$queryRaw<Array<ServingRow>>`
          SELECT serving_source, digest_sender, drift_sender FROM trade_request.serving_state WHERE id FOR UPDATE`;
        const refusal = writeRefusal(mode, s) ?? (await forwardTransitionRefusal(tx, mode));
        if (refusal) throw new CopyRefused(refusal);
      }
      const current = mode === "full" ? null : await allHashes(tx, to);
      // Deletes first, children before parents, so a re-added unique tuple never collides.
      for (const kind of [...RECORD_KINDS].reverse()) {
        if (mode === "full") {
          await tx.$executeRawUnsafe(`DELETE FROM ${rel(to, kind)}`);
        } else if (!(back && kind.neverDeleteOnCopyBack)) {
          const f = snapshot.h.get(kind.table)!;
          await deleteKeys(tx, to, kind, [...current!.get(kind.table)!.keys()].filter((k) => !f.has(k)));
        }
      }
      // Inserts and updates, parents before children.
      for (const kind of RECORD_KINDS) {
        const texts = snapshot.rows.get(kind.table)!;
        const present = current?.get(kind.table);
        const inserts: string[] = [];
        const updates: string[] = [];
        for (const [k, j] of texts) (present?.has(k) ? updates : inserts).push(j);
        await insertRows(tx, to, kind, hooks?.beforeInsert ? hooks.beforeInsert(kind.table, inserts) : inserts);
        if (updates.length > 0) await updateRows(tx, to, kind, await columns(tx, to, kind), updates, back);
      }
      return compare(snapshot.h, await allHashes(tx, to), mode);
    }, TX_OPTIONS);
  }

  const verdict: CopyResult["verdict"] =
    mode === "report" ? "report_only" : kinds.every((k) => k.missing + k.differing + k.extra === 0) ? "passed" : "blocked";
  await target.$executeRaw`
    UPDATE trade_request.copy_runs
       SET finished_at = NOW(), verdict = ${verdict}, kinds = ${JSON.stringify(kinds)}::jsonb
     WHERE id = ${runId}::uuid`;
  return { runId, mode, verdict, kinds };
}
