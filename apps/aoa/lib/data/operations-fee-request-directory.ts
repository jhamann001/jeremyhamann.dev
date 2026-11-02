import "server-only";
import { Prisma } from "@prisma/client";
import type { FeeRequestQuery } from "@/lib/operations/fee-request-query";

type RequestRecord = Prisma.OperationsFeeRequestGetPayload<{ include: { events: true } }>;
export type FeeRequestDirectoryMeta = {
  total: number; page: number; pageSize: number; pageCount: number; snapshot: string; queryKey: string;
  counts: { pending: number; approved: number; credited: number; closed: number; total: number };
};
type DirectoryEnvelope = {
  records: Array<Record<string, unknown>>;
  total: bigint; pending: bigint; approved: bigint; credited: bigint; closed: bigint; snapshot: string;
};

/** One statement fixes membership, ordering, counts, request bodies and events together under RLS. */
export async function selectFeeRequestDirectory(tx: Prisma.TransactionClient, query: FeeRequestQuery): Promise<{
  requests: RequestRecord[]; meta: FeeRequestDirectoryMeta;
}> {
  const { filters, page, pageSize } = query;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 100 || pageSize > 200) {
    throw new Error("invalid_fee_request_query");
  }
  const search = `%${filters.query.replace(/[\\%_]/g, "\\$&")}%`;
  const conditions = [filters.tab === "credits" ? Prisma.sql`r.kind = 'FEE_CREDIT'` : Prisma.sql`r.kind <> 'FEE_CREDIT'`];
  if (filters.type) conditions.push(Prisma.sql`r.kind::text = ${filters.type}`);
  if (filters.status) conditions.push(Prisma.sql`r.status::text = ${filters.status}`);
  if (filters.from) conditions.push(Prisma.sql`r.submitted_at >= (${filters.from}::date::timestamp AT TIME ZONE 'America/New_York')`);
  if (filters.to) conditions.push(Prisma.sql`r.submitted_at < ((${filters.to}::date + 1)::timestamp AT TIME ZONE 'America/New_York')`);
  const orderColumn = filters.sort === "amount" ? Prisma.sql`fee_amount` : filters.sort === "waiver" ? Prisma.sql`waiver_start` : Prisma.sql`submitted_at`;
  const direction = filters.dir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const [result] = await tx.$queryRaw<DirectoryEnvelope[]>(Prisma.sql`
    WITH labeled AS MATERIALIZED (
      SELECT r.*,
             COALESCE(r.legacy_client_name, client.name, 'Client unavailable') AS client_label,
             COALESCE(household.name, client.household_name, '') AS household_label,
             COALESCE((SELECT md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id))
                         FROM app.operations_fee_request_event e WHERE e.request_id = r.id), '') AS event_version,
             COALESCE((SELECT md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.custodian_account_id))
                         FROM mirror.client_account_aum a WHERE a.custodian_account_id = ANY(r.account_ids)), '') AS account_version
        FROM app.operations_fee_request r
        LEFT JOIN LATERAL (
          SELECT trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
                 h.name AS household_name
            FROM mirror.client c
            LEFT JOIN mirror.household h ON h.sf_id = c.household_id OR (
              h.sf_id ~ '^[A-Za-z0-9]{15,18}$' AND c.household_id ~ '^[A-Za-z0-9]{15,18}$'
              AND left(h.sf_id, 15) = left(c.household_id, 15))
           WHERE c.sf_id = r.client_sf_id OR (
             c.sf_id ~ '^[A-Za-z0-9]{15,18}$' AND r.client_sf_id ~ '^[A-Za-z0-9]{15,18}$'
             AND left(c.sf_id, 15) = left(r.client_sf_id, 15))
           ORDER BY (c.sf_id = r.client_sf_id) DESC, c.sf_id, h.sf_id
           LIMIT 1
        ) client ON true
        LEFT JOIN LATERAL (
          SELECT h.name FROM mirror.household h
           WHERE h.sf_id = r.legacy_household_sf_id OR (
             h.sf_id ~ '^[A-Za-z0-9]{15,18}$' AND r.legacy_household_sf_id ~ '^[A-Za-z0-9]{15,18}$'
             AND left(h.sf_id, 15) = left(r.legacy_household_sf_id, 15))
           ORDER BY (h.sf_id = r.legacy_household_sf_id) DESC, h.sf_id LIMIT 1
        ) household ON true
       WHERE ${Prisma.join(conditions, " AND ")}
    ), filtered AS MATERIALIZED (
      SELECT * FROM labeled
       WHERE ${filters.query === ""} OR id ILIKE ${search} OR client_label ILIKE ${search} OR household_label ILIKE ${search}
    ), stats AS (
      SELECT count(*)::bigint AS total,
             count(*) FILTER (WHERE status = 'PENDING')::bigint AS pending,
             count(*) FILTER (WHERE status = 'APPROVED')::bigint AS approved,
             count(*) FILTER (WHERE status = 'CREDITED')::bigint AS credited,
             count(*) FILTER (WHERE status IN ('REJECTED', 'CANCELLED'))::bigint AS closed,
             md5(COALESCE(string_agg(md5(to_jsonb(filtered)::text), '' ORDER BY id), '')) AS snapshot
        FROM filtered
    ), page_rows AS (
      SELECT *, row_number() OVER (ORDER BY ${orderColumn} ${direction} NULLS LAST, id ASC) AS ordinal
        FROM filtered
       ORDER BY ${orderColumn} ${direction} NULLS LAST, id ASC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    )
    SELECT stats.*,
           COALESCE((SELECT jsonb_agg((to_jsonb(p) - 'client_label' - 'household_label' - 'event_version' - 'account_version' - 'ordinal')
             || jsonb_build_object('events', COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('id', e.id::text) ORDER BY e.at, e.id)
                  FROM app.operations_fee_request_event e WHERE e.request_id = p.id), '[]'::jsonb)) ORDER BY p.ordinal)
             FROM page_rows p), '[]'::jsonb) AS records
      FROM stats`);
  if (!result) throw new Error("fee_request_directory_unavailable");
  if (query.snapshot && query.snapshot !== result.snapshot) throw new Error("fee_request_directory_changed");
  const total = Number(result.total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (page > pageCount) throw new Error("fee_request_page_out_of_range");
  const requests = result.records.map((record) => {
    const revived = { ...record };
    for (const field of ["submitted_at", "reviewed_at", "credited_at", "completed_at", "created_at", "updated_at", "waiver_start"]) {
      revived[field] = record[field] === null ? null : new Date(record[field] as string);
    }
    revived.fee_amount = record.fee_amount === null ? null : new Prisma.Decimal(String(record.fee_amount));
    revived.events = (record.events as Array<Record<string, unknown>>).map((event) => ({ ...event, id: BigInt(event.id as string), at: new Date(event.at as string) }));
    return revived as RequestRecord;
  });
  return { requests, meta: {
    total, page, pageSize, pageCount, snapshot: result.snapshot, queryKey: query.queryKey,
    counts: { pending: Number(result.pending), approved: Number(result.approved), credited: Number(result.credited), closed: Number(result.closed), total },
  } };
}
