"use client";

import type { ZendeskTicket } from "@/lib/data/types";
import { utcDateLabel, utcDateTimeLabel } from "@/lib/display-date";
import { Pill, type PillTone } from "@/components/ui";
import styles from "./ZendeskTicketsCard.module.css";

function isClosed(status: string): boolean {
  return ["solved", "closed"].includes(status.trim().toLowerCase());
}

function tone(status: string): PillTone {
  switch (status.trim().toLowerCase()) {
    case "new": return "blue";
    case "open": return "green";
    case "pending":
    case "hold": return "gold";
    default: return "gray";
  }
}

function TicketConversation({ ticket }: { ticket: ZendeskTicket }) {
  const subject = ticket.subject ?? "Untitled ticket";
  const commentCount = ticket.comments.length;
  const collapsedLabel = commentCount > 0
    ? `View ${commentCount} ${commentCount === 1 ? "comment" : "comments"}`
    : ticket.description
      ? "View request"
      : "View details";
  const expandedLabel = commentCount > 0
    ? "Hide comments"
    : ticket.description
      ? "Hide request"
      : "Hide details";

  return (
    <details className={styles.ticket}>
      <summary className={styles.ticketSummary}>
        <a
          className={styles.subjectLink}
          href={ticket.ticket_url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${subject} — open in Zendesk (new tab)`}
          onClick={(event) => event.stopPropagation()}
        >
          #{ticket.zendesk_ticket_id} · {subject} <span aria-hidden="true">↗</span>
        </a>
        <Pill tone={tone(ticket.status)}>{ticket.status}</Pill>
        <span className={styles.date}>
          {utcDateLabel(ticket.source_updated_at)}
        </span>
        <span className={styles.ticketAction}>
          <span className={styles.viewLabel}>{collapsedLabel}</span>
          <span className={styles.hideLabel}>{expandedLabel}</span>
          <span className={styles.ticketChevron} aria-hidden="true">⌄</span>
        </span>
      </summary>
      <div className={styles.conversation}>
        <div className={styles.meta}>
          {ticket.priority ? <span>Priority: {ticket.priority}</span> : null}
          {ticket.ticket_type ? <span>Type: {ticket.ticket_type}</span> : null}
          <a
            href={ticket.ticket_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Zendesk ↗
          </a>
        </div>
        {ticket.comments.length > 0 ? (
          <ol className={styles.comments}>
            {ticket.comments.map((comment) => (
              <li key={comment.zendesk_comment_id} className={styles.comment}>
                <div className={styles.commentHead}>
                  <strong>
                    {comment.author_id === ticket.requester_id
                      ? "Client"
                      : "Cedar Ridge support"}
                  </strong>
                  <span>{utcDateTimeLabel(comment.created_at)}</span>
                </div>
                <p>{comment.body}</p>
              </li>
            ))}
          </ol>
        ) : ticket.description ? (
          <div className={styles.comment}>
            <div className={styles.commentHead}><strong>Initial request</strong></div>
            <p>{ticket.description}</p>
          </div>
        ) : (
          <p className={styles.empty}>No public conversation content is available.</p>
        )}
        {ticket.comments_truncated ? (
          <p className={styles.empty}>
            Showing the 100 most recent public comments. Open Zendesk for the full thread.
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function ZendeskTicketsCard({
  tickets,
  scope,
}: {
  tickets: ZendeskTicket[];
  scope: "household" | "client";
}) {
  const open = tickets.filter((ticket) => !isClosed(ticket.status));
  const resolved = tickets.length - open.length;

  return (
    <details className={styles.card}>
      <summary className={styles.summary}>
        <h2>Zendesk tickets</h2>
        <span className={styles.count}>{open.length} active · {resolved} resolved</span>
        <span className={styles.disclosure} aria-hidden="true">＋</span>
      </summary>
      <div className={styles.body}>
        <p className={styles.sub}>
          {scope === "household"
            ? "Household-level support tickets from Zendesk."
            : "Support tickets linked to this client."}
        </p>
        {tickets.length === 0 ? (
          <p className={styles.empty}>No linked Zendesk tickets.</p>
        ) : (
          <div className={styles.list}>
            {tickets.map((ticket) => (
              <TicketConversation key={ticket.zendesk_ticket_id} ticket={ticket} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
