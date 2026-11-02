import type { Prisma } from "@prisma/client";
import { INGEST_ZENDESK_TICKETS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { logIngestSuccess } from "@/lib/observability/structured-log";
import type {
  IngestErrorBody,
  RejectedItem,
  ZendeskTicketsItem,
} from "@/lib/ingest/types";
import {
  validateEnvelope,
  validateZendeskTicketsItem,
} from "@/lib/ingest/validate";

export const runtime = "nodejs";

const MAX_ITEMS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

type MatchMethod = "CEDAR_RIDGE_USER_ID" | "EMAIL" | "UNMATCHED" | "AMBIGUOUS";
type LinkResolution = {
  match_method: MatchMethod;
  client_sf_id: string | null;
  household_sf_id: string | null;
};

type ZendeskIngestResponse = {
  upserted?: number;
  would_upsert?: number;
  rejected: RejectedItem[];
  run_id: string;
  linkage: Record<MatchMethod, number>;
  public_comments: number;
};

const err = (error: IngestErrorBody["error"], status: number) =>
  Response.json({ error } satisfies IngestErrorBody, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

function emptyLinkage(): Record<MatchMethod, number> {
  return { CEDAR_RIDGE_USER_ID: 0, EMAIL: 0, UNMATCHED: 0, AMBIGUOUS: 0 };
}

/** Resolve one requester without persisting its email or Cedar Ridge user ID.
 * Confirmed duplicate source records collapse through AOA's canonical-contact
 * function before cardinality is counted, so two source shells for one
 * confirmed person do not create a false ambiguity. */
async function resolveLink(
  tx: Prisma.TransactionClient,
  item: ZendeskTicketsItem,
): Promise<LinkResolution> {
  const [row] = await tx.$queryRaw<LinkResolution[]>`
    WITH candidate AS MATERIALIZED (
      SELECT DISTINCT
             app.resolve_crm_canonical_contact_source_key(client.sf_id)
               AS client_sf_id,
             1 AS match_priority
        FROM mirror.client client
       WHERE ${item.requester_cedar_ridge_user_id}::text IS NOT NULL
         AND lower(btrim(client.cedar_ridge_user_id)) =
             lower(btrim(${item.requester_cedar_ridge_user_id}::text))
      UNION
      SELECT DISTINCT
             app.resolve_crm_canonical_contact_source_key(client.sf_id)
               AS client_sf_id,
             2 AS match_priority
        FROM mirror.client client
       WHERE ${item.requester_email}::text IS NOT NULL
         AND lower(btrim(client.email)) = lower(btrim(${item.requester_email}::text))
    ), preferred AS MATERIALIZED (
      SELECT DISTINCT candidate.client_sf_id, candidate.match_priority
        FROM candidate
       WHERE candidate.match_priority = (SELECT min(match_priority) FROM candidate)
    ), decision AS (
      SELECT count(*)::integer AS candidate_count,
             min(client_sf_id) AS client_sf_id,
             min(match_priority)::integer AS match_priority
        FROM preferred
    )
    SELECT CASE
             WHEN decision.candidate_count > 1 THEN 'AMBIGUOUS'
             WHEN decision.candidate_count = 0 THEN 'UNMATCHED'
             WHEN decision.match_priority = 1 THEN 'CEDAR_RIDGE_USER_ID'
             ELSE 'EMAIL'
           END::text AS match_method,
           CASE WHEN decision.candidate_count = 1
                THEN decision.client_sf_id ELSE NULL END AS client_sf_id,
           CASE WHEN decision.candidate_count = 1 THEN (
             SELECT app.resolve_crm_canonical_household_source_key(client.household_id)
               FROM mirror.client client
              WHERE left(client.sf_id, 15) = left(decision.client_sf_id, 15)
              ORDER BY client.sf_id
              LIMIT 1
           ) ELSE NULL END AS household_sf_id
      FROM decision`;

  return row ?? {
    match_method: "UNMATCHED",
    client_sf_id: null,
    household_sf_id: null,
  };
}

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return err("too_large", 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", 400);
  }
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_BODY_BYTES)
    return err("too_large", 413);

  const parsed = validateEnvelope(body);
  if (!parsed.ok) return err("bad_request", 400);
  const { source, run_id, items } = parsed.envelope;
  if (items.length > MAX_ITEMS) return err("too_large", 413);

  const rejected: RejectedItem[] = [];
  const okItems: ZendeskTicketsItem[] = [];
  items.forEach((item, index) => {
    const rejection = validateZendeskTicketsItem(item, index);
    if (rejection) rejected.push(rejection);
    else okItems.push(item as ZendeskTicketsItem);
  });

  // Last item wins when a source sends the same ticket twice in one run.
  const tickets = new Map(okItems.map((item) => [item.zendesk_ticket_id, item]));
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const linkage = emptyLinkage();
  const publicCommentCount = [...tickets.values()].reduce(
    (total, ticket) => total + ticket.comments.length,
    0,
  );

  try {
    await withIngestScope(async (tx) => {
      for (const item of tickets.values()) {
        const link = await resolveLink(tx, item);
        linkage[link.match_method] += 1;

        if (!dryRun) {
          await tx.$executeRaw`
            INSERT INTO mirror.zendesk_ticket
              (zendesk_ticket_id, requester_id, client_sf_id, household_sf_id,
               match_method, subject, description, status, priority, ticket_type, ticket_url,
               created_at, source_updated_at, comments_truncated)
            VALUES
              (${item.zendesk_ticket_id}, ${item.requester_id},
               ${link.client_sf_id}, ${link.household_sf_id}, ${link.match_method},
               ${item.subject}, ${item.description}, ${item.status}, ${item.priority},
               ${item.ticket_type}, ${item.ticket_url},
               ${item.created_at}::timestamptz, ${item.updated_at}::timestamptz,
               ${item.comments_truncated})
            ON CONFLICT (zendesk_ticket_id) DO UPDATE SET
              requester_id = EXCLUDED.requester_id,
              client_sf_id = EXCLUDED.client_sf_id,
              household_sf_id = EXCLUDED.household_sf_id,
              match_method = EXCLUDED.match_method,
              subject = EXCLUDED.subject,
              description = EXCLUDED.description,
              status = EXCLUDED.status,
              priority = EXCLUDED.priority,
              ticket_type = EXCLUDED.ticket_type,
              ticket_url = EXCLUDED.ticket_url,
              created_at = EXCLUDED.created_at,
              source_updated_at = EXCLUDED.source_updated_at,
              comments_truncated = EXCLUDED.comments_truncated,
              synced_at = now()
          `;
          for (const comment of item.comments) {
            await tx.$executeRaw`
              INSERT INTO mirror.zendesk_ticket_comment
                (zendesk_comment_id, zendesk_ticket_id, author_id, body, created_at)
              VALUES
                (${comment.zendesk_comment_id}, ${item.zendesk_ticket_id},
                 ${comment.author_id}, ${comment.body},
                 ${comment.created_at}::timestamptz)
              ON CONFLICT (zendesk_comment_id) DO UPDATE SET
                zendesk_ticket_id = EXCLUDED.zendesk_ticket_id,
                author_id = EXCLUDED.author_id,
                body = EXCLUDED.body,
                created_at = EXCLUDED.created_at,
                synced_at = now()
            `;
          }
        }
      }

      await writeAudit(
        tx,
        { role: "INGEST", email: null },
        {
          action: INGEST_ZENDESK_TICKETS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "zendesk-tickets",
            received: items.length,
            upserted: okItems.length,
            rejected: rejected.length,
            linkage,
            public_comments: publicCommentCount,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    // Deliberately constant: request-controlled run IDs and ticket content must
    // never enter infrastructure logs, even after encoding.
    console.error("[ingest] zendesk-tickets tx_failed");
    return err("internal", 500);
  }

  if (!dryRun && rejected.length === 0) logIngestSuccess("zendesk-tickets");
  return Response.json({
    ...(dryRun
      ? { would_upsert: tickets.size }
      : { upserted: tickets.size }),
    rejected,
    run_id,
    linkage,
    public_comments: publicCommentCount,
  } satisfies ZendeskIngestResponse);
}
