import type { ActivityItem } from "@/types/domain";
import { formatDateTime, formatRelative, labelize } from "@/lib/format";
import {
  describeFieldChange,
  describeIngest,
  displayValue,
  macroActionsSentence,
  type FieldChange,
} from "@/components/ticket/activity-text";

/**
 * One system event on the ticket timeline: "Olivia Ops changed status Open →
 * Resolved · 2m ago", "Mia Ops set first response to Sep 16, 2026 23:21 · just now". Compact, grey,
 * server-rendered. Wording comes from the pure helpers in `activity-text.ts`: raw
 * column names never reach the row, empty→value reads "set … to …", value→empty reads "cleared …".
 */

function Value({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-foreground">{children}</span>;
}

function Arrow(): React.JSX.Element {
  return (
    <>
      <span aria-hidden> → </span>
      <span className="sr-only">to</span>
    </>
  );
}

function FieldChangeText({ change }: { change: FieldChange }): React.JSX.Element {
  switch (change.kind) {
    case "set":
      return (
        <>
          set {change.field} to <Value>{change.to}</Value>
        </>
      );
    case "changed":
      return (
        <>
          changed {change.field} <Value>{change.from}</Value>
          <Arrow />
          <Value>{change.to}</Value>
        </>
      );
    case "cleared":
      return (
        <>
          cleared {change.field}
          {change.from !== null ? <span className="opacity-80"> (was {change.from})</span> : null}
        </>
      );
  }
}

function describe(item: ActivityItem): React.ReactNode {
  switch (item.action) {
    case "TICKET_CREATED":
      return "created the ticket";
    case "TICKET_STATUS_CHANGED":
      return <FieldChangeText change={describeFieldChange(item.fieldChanged ?? "status", item.oldValue, item.newValue)} />;
    case "TICKET_PRIORITY_CHANGED":
      return <FieldChangeText change={describeFieldChange(item.fieldChanged ?? "priority", item.oldValue, item.newValue)} />;
    case "TICKET_FIELD_CHANGED":
      return <FieldChangeText change={describeFieldChange(item.fieldChanged, item.oldValue, item.newValue)} />;
    case "TICKET_QUEUE_CHANGED":
      return (
        <>
          moved the ticket <Value>{displayValue("queueKey", item.oldValue) ?? "—"}</Value>
          <Arrow />
          <Value>{displayValue("queueKey", item.newValue) ?? "—"}</Value>
        </>
      );
    case "TICKET_ASSIGNED":
      // CONTRACT-GAP: ActivityItem carries only the old/new assignee ids (emails live in AuditLog.metadata,
      // which the DTO does not expose), so the row states the change without echoing opaque ids.
      return item.newValue === null ? "cleared the assignee" : item.oldValue === null ? "assigned the ticket" : "reassigned the ticket";
    case "MACRO_APPLIED":
      return (
        <>
          applied macro <span className="font-mono text-foreground">{item.newValue ?? "—"}</span>
        </>
      );
    case "PII_REDACTED":
      return (
        <>
          had sensitive numbers redacted before saving{item.fieldChanged ? ` (${item.fieldChanged})` : ""}
          {item.newValue ? <span className="font-mono text-foreground"> {item.newValue}</span> : null}
        </>
      );

    // --- Wave B (integration round 1). Every action `TIMELINE_AUDIT_ACTIONS` added now has its own
    // sentence; before this they all fell through to `labelize(...).toLowerCase()` and read as
    // "comment retracted", "identity gate overridden" — grammatical noise in a chronology a reviewer
    // reads top to bottom. `ActivityItem` carries no `metadata`, so a row says only what the four
    // hash-chained columns hold; where a number or a reason lives in metadata it is deliberately not
    // invented here. ---

    // Fix round 2: `fieldChanged` is "kind" and the value is a raw `TicketLinkKind`, so these read
    // "linked this ticket DUPLICATE_OF" until `displayValue` learned the enum. The em dash is
    // deliberate — "Duplicate of" is a LABEL, the same word the links panel prints on the same row,
    // and folding a label into the sentence ("linked this ticket blocks") reads worse than annotating
    // it. The other ticket's WM number lives in `metadata`, which this DTO does not carry.
    case "TICKET_LINK_ADDED":
      return (
        <>
          linked this ticket — <Value>{displayValue(item.fieldChanged, item.newValue) ?? "—"}</Value>
        </>
      );
    case "TICKET_LINK_REMOVED":
      return (
        <>
          removed a link — <Value>{displayValue(item.fieldChanged, item.oldValue) ?? "—"}</Value>
        </>
      );
    case "TICKET_MERGED":
      // The survivor's WM number is in metadata, which this DTO does not carry; the duplicate banner
      // on the ticket itself is where a reader follows the merge.
      return "merged this ticket into another as a duplicate";
    case "TICKET_VOIDED":
      // The recorded reason is in metadata; the void banner shows it. This row is the WHEN and WHO.
      return (
        <>
          voided the ticket — entered in error
          {displayValue("status", item.oldValue) === null ? null : (
            <span className="opacity-80"> (was {displayValue("status", item.oldValue)})</span>
          )}
        </>
      );
    case "COMMENT_RETRACTED":
      return "withdrew a reply to the client";
    case "MACRO_ACTIONS_APPLIED":
      // Fix round 2: `newValue` is `applied.join(",")` — literal column names — so this row read
      // "applied macro actions queueKey,status,followUpInDays". Each name now goes through the same
      // `fieldLabel` every other row uses.
      return (
        <>
          applied macro actions <Value>{macroActionsSentence(item.newValue) ?? "—"}</Value>
        </>
      );
    case "REVIEW_STAMPED":
      return (
        <>
          reviewed a reply <Value>{labelize(item.newValue ?? "").toLowerCase() || "—"}</Value>
        </>
      );
    case "IDENTITY_VERIFIED":
      return (
        <>
          recorded an identity verification <Value>{labelize(item.newValue ?? "").toLowerCase() || "—"}</Value>
        </>
      );
    case "IDENTITY_GATE_OVERRIDDEN":
      // Deliberately blunt. This is the row a reviewer is looking for when they ask how a money
      // movement was resolved without a verification, and it should not read like routine housekeeping.
      return "resolved this WITHOUT an identity verification, with a recorded reason";
    case "TICKET_IMPORTED":
      // `newValue` is a JSON summary of the import (external id, source, counts). Shown as stored
      // rather than re-formatted: it is a provenance record, and it is short.
      return (
        <>
          imported this ticket from the archive <Value>{item.newValue ?? "—"}</Value>
        </>
      );
    case "TICKET_INGESTED": {
      // Fix round 2. This fell through to the default and read "ticket ingested" — which tells a
      // reader a CHANNEL delivered the ticket even when a person typed it at their desk, because B11
      // routes /tickets/new's Phone, Voicemail and In-person forms through the ingest core. The verb
      // now follows the recorded source, and an unreadable summary says only "received this ticket".
      const ingest = describeIngest(item.newValue);
      return (
        <>
          {ingest.verb}
          {ingest.source === null ? null : (
            <>
              {" "}
              <Value>({ingest.source})</Value>
            </>
          )}
        </>
      );
    }
    case "TICKET_REQUESTER_EMAIL_CHANGED":
      // Carried from Wave A, where it borrowed TICKET_FIELD_CHANGED and rendered through the same
      // helper. Kept identical on purpose: a reader of an old row and a new one sees the same sentence.
      return <FieldChangeText change={describeFieldChange("requesterEmail", item.oldValue, item.newValue)} />;

    // GENERIC FALLBACK. Reaching it is a defect for any action on `TIMELINE_AUDIT_ACTIONS`: it prints
    // the enum with the underscores taken out, which is how the link and macro rows above read before
    // this pass. `activity-text.test.ts` pins the set of timeline actions that deliberately still land
    // here, so adding one to `TIMELINE_AUDIT_ACTIONS` without a sentence fails a test rather than
    // shipping "sla alert" onto a compliance reviewer's chronology.
    default:
      return labelize(item.action).toLowerCase();
  }
}

export function ActivityRow({ item }: { item: ActivityItem }): React.JSX.Element {
  const actor = item.actorName?.trim() || item.actorEmail;
  return (
    <li
      className="flex flex-wrap items-baseline gap-x-1.5 px-1 py-1 text-xs text-muted-foreground"
      data-activity-action={item.action}
      data-seq={item.seq}
    >
      <span aria-hidden className="mr-1 inline-block size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-border" />
      <span className="font-medium text-foreground/80">{actor}</span>
      <span className="min-w-0 break-words">{describe(item)}</span>
      <span aria-hidden>·</span>
      <time dateTime={item.occurredAt} title={formatDateTime(item.occurredAt)} className="tabular-nums">
        {formatRelative(item.occurredAt)}
      </time>
    </li>
  );
}
