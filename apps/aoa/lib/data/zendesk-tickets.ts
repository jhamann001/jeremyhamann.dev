import { Prisma } from "@prisma/client";
import { resolveCrmRouteKey } from "@/lib/crm/resolve";
import { withUserScope } from "@/lib/rls";
import type {
  Identity,
  ZendeskTicket,
  ZendeskTicketComment,
} from "./types";

type TicketRow = Omit<ZendeskTicket, "comments">;
type CommentRow = ZendeskTicketComment & { zendesk_ticket_id: string };

async function readTickets(
  identity: Identity,
  predicate: Prisma.Sql,
  limit: number,
): Promise<ZendeskTicket[]> {
  return withUserScope(identity, async (tx) => {
    const tickets = await tx.$queryRaw<TicketRow[]>(Prisma.sql`
      SELECT zendesk_ticket_id, requester_id, subject, description, status,
             priority, ticket_type, ticket_url, created_at, source_updated_at,
             comments_truncated
        FROM mirror.zendesk_ticket ticket
       WHERE ${predicate}
       ORDER BY source_updated_at DESC
       LIMIT ${limit}`);
    if (tickets.length === 0) return [];

    const ticketIds = tickets.map((ticket) => ticket.zendesk_ticket_id);
    const comments = await tx.$queryRaw<CommentRow[]>(Prisma.sql`
      SELECT zendesk_comment_id, zendesk_ticket_id, author_id, body, created_at
        FROM mirror.zendesk_ticket_comment
       WHERE zendesk_ticket_id IN (${Prisma.join(ticketIds)})
       ORDER BY created_at ASC`);
    const commentsByTicket = new Map<string, ZendeskTicketComment[]>();
    for (const comment of comments) {
      const ticketId = comment.zendesk_ticket_id;
      const bucket = commentsByTicket.get(ticketId) ?? [];
      bucket.push({
        zendesk_comment_id: comment.zendesk_comment_id,
        author_id: comment.author_id,
        body: comment.body,
        created_at: comment.created_at,
      });
      commentsByTicket.set(ticketId, bucket);
    }
    return tickets.map((ticket) => ({
      ...ticket,
      comments: commentsByTicket.get(ticket.zendesk_ticket_id) ?? [],
    }));
  });
}

export async function zendeskTicketsForClient(
  identity: Identity,
  clientSfId: string,
): Promise<ZendeskTicket[]> {
  const canonical = await resolveCrmRouteKey(identity, "CONTACT", clientSfId);
  return readTickets(
    identity,
    Prisma.sql`ticket.client_sf_id IS NOT NULL
      AND left(app.resolve_crm_canonical_contact_source_key(ticket.client_sf_id), 15)
          = left(${canonical}, 15)`,
    50,
  );
}

export async function zendeskTicketsForHouseholdSources(
  identity: Identity,
  householdSfIds: string[],
): Promise<ZendeskTicket[]> {
  const keys = [...new Set(
    householdSfIds.filter(Boolean).map((value) => value.slice(0, 15)),
  )].slice(0, 16);
  if (keys.length === 0) return [];
  return readTickets(
    identity,
    Prisma.sql`(
      (
        ticket.household_sf_id IS NOT NULL
        AND left(ticket.household_sf_id, 15) IN (${Prisma.join(keys)})
      )
      OR (
        ticket.client_sf_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM mirror.client household_member
           WHERE household_member.household_id IS NOT NULL
             AND left(household_member.household_id, 15)
                 IN (${Prisma.join(keys)})
             AND left(
                   app.resolve_crm_canonical_contact_source_key(
                     household_member.sf_id
                   ),
                   15
                 ) = left(
                   app.resolve_crm_canonical_contact_source_key(
                     ticket.client_sf_id
                   ),
                   15
                 )
        )
      )
    )`,
    100,
  );
}
