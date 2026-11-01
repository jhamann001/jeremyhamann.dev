/**
 * The starting macro set and its create-if-missing seeder. Moved out of seed.ts so the demo reset
 * (demo-reset.ts) can write it inside its own transaction; seed.ts calls main() at the top level and
 * cannot be imported.
 */
import type { DbTx } from "../src/lib/db";
import type { CommentVisibility, DisclaimerKey, QueueKey } from "../src/types/domain";

// ---------------------------------------------------------------------------
// Step 4 — macros (CREATE-IF-MISSING by key). Bodies use the five placeholders:
// {{ticket.number}} {{requester.name}} {{requester.firstName}} {{agent.name}} {{today}}
//
// Wave A, slice S9. This step used to UPSERT, which meant every deploy
// re-applied the bodies below and silently reverted anything changed at runtime. Now that
// `/admin/macros` can edit a macro — and writes an audit row carrying the wording it replaced — a
// seeder that overwrote a body would destroy the very thing that makes runtime editing safe: the
// stored text would stop matching the last `MACRO_UPDATED` row, and a client could be sent wording
// nobody approved. So an EXISTING key is left exactly as it is and the skip is logged; only a missing
// key is created. This file is therefore the STARTING set, not the running set.
//
// To change a macro's wording: edit it at /admin/macros (audited), or, if the change must ship as
// code, retire the key there and add a new key here.
// ---------------------------------------------------------------------------

export type MacroSeed = {
  key: string;
  title: string;
  /** null = available in every queue */
  queueKey: QueueKey | null;
  channel: CommentVisibility;
  disclaimerKey: DisclaimerKey;
  sortOrder: number;
  /**
   * whether the macro is offered in the composer when it is first created. Every seeded
   * macro ships active; the field exists so a macro can be shipped pre-retired (for a queue that is
   * not live yet, say) without editing the seeder's logic. It applies on CREATE only — a macro
   * retired at runtime is never reactivated by a deploy.
   */
  isActive: boolean;
  body: string;
};

export const MACRO_SEED: readonly MacroSeed[] = [
  {
    key: "wire-verification-notice",
    title: "Wire verification notice",
    queueKey: "OPERATIONS",
    channel: "PUBLIC",
    disclaimerKey: "WIRE_VERIFICATION",
    sortOrder: 10,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "Wire Verification Notice: we will call the phone number on file to verbally confirm the wire " +
      "instructions on {{ticket.number}} before any funds are released. Please do not send account or " +
      "routing details by email; we will confirm them with you, {{requester.name}}, on the call.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "wire-callback-completed",
    title: "Wire callback completed (internal)",
    queueKey: "OPERATIONS",
    channel: "INTERNAL",
    disclaimerKey: "NONE",
    sortOrder: 20,
    isActive: true,
    body:
      "INTERNAL — not for client: verbal callback for {{ticket.number}} completed with {{requester.name}} " +
      "({{requester.firstName}} confirmed identity on the number on file) by {{agent.name}} on {{today}}. " +
      "Instructions match the signed letter of authorization; clear to release at the next wire window.",
  },
  {
    key: "acat-status-update",
    title: "ACAT status update",
    queueKey: "OPERATIONS",
    channel: "PUBLIC",
    disclaimerKey: "GENERAL_SERVICE",
    sortOrder: 30,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "Here is the status of your account transfer ({{ticket.number}}): the receiving custodian has " +
      "submitted the request and the delivering firm is reviewing it. Most transfers settle within five to " +
      "seven business days once accepted. We will update you, {{requester.name}}, as soon as assets arrive.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "trade-correction-ack",
    title: "Trade correction acknowledged",
    queueKey: "OPERATIONS",
    channel: "PUBLIC",
    disclaimerKey: "GENERAL_SERVICE",
    sortOrder: 40,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "We have received your trade correction request ({{ticket.number}}) and have opened a case with the " +
      "custodian. Corrections post as a cancel-and-rebook, so you may see two entries on your activity " +
      "before they net. We will confirm with you, {{requester.name}}, when the custodian has completed it.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "1099-availability",
    title: "Form 1099 availability",
    queueKey: "CLIENT_SERVICE",
    channel: "PUBLIC",
    disclaimerKey: "TAX_DOCUMENT",
    sortOrder: 50,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "Regarding {{ticket.number}}: consolidated Forms 1099 are produced by the custodian and posted to the " +
      "Documents tab of your portal as they become available, typically in waves through mid-March. If your " +
      "form is later corrected, a revised copy will appear in the same place, {{requester.name}}.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "portal-reset-steps",
    title: "Portal reset steps",
    queueKey: "CLIENT_SERVICE",
    channel: "PUBLIC",
    disclaimerKey: "GENERAL_SERVICE",
    sortOrder: 60,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "To restore your portal access ({{ticket.number}}): open the portal sign-in page, choose “Forgot " +
      "password”, and follow the link we send to the email address on file. The link expires after one " +
      "hour. If you do not receive it, {{requester.name}}, reply here and we will reissue it.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "address-change-verification",
    title: "Address change verification",
    queueKey: "CLIENT_SERVICE",
    channel: "PUBLIC",
    disclaimerKey: "GENERAL_SERVICE",
    sortOrder: 70,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "We received your address change request ({{ticket.number}}). For your protection we verify address " +
      "changes by a call to the phone number on file before updating the custodian record; expect our call " +
      "within one business day, {{requester.name}}.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "rebalance-ack",
    title: "Rebalancing request acknowledged",
    queueKey: "ADVICE",
    channel: "PUBLIC",
    disclaimerKey: "INVESTMENT_ADVICE",
    sortOrder: 80,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "Thank you for your rebalancing request ({{ticket.number}}). Your advisor is reviewing the proposed " +
      "trades against your investment policy statement and will share the recommendation with you, " +
      "{{requester.name}}, before anything is executed.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "tlh-explainer",
    title: "Tax-loss harvesting explainer",
    queueKey: "ADVICE",
    channel: "PUBLIC",
    disclaimerKey: "NOT_TAX_OR_LEGAL_ADVICE",
    sortOrder: 90,
    isActive: true,
    body:
      "Hello {{requester.firstName}},\n\n" +
      "On {{ticket.number}} you asked how tax-loss harvesting works: positions with unrealized losses are " +
      "sold to realize the loss and replaced with a similar (not substantially identical) holding so your " +
      "allocation stays in place. Wash-sale rules apply across your accounts, {{requester.name}}, so please " +
      "review the details with your tax professional.\n\n" +
      "Kind regards,\n{{agent.name}}\n{{today}}",
  },
  {
    key: "escalated-to-compliance",
    title: "Escalated to compliance (internal)",
    queueKey: null,
    channel: "INTERNAL",
    disclaimerKey: "NONE",
    sortOrder: 100,
    isActive: true,
    body:
      "INTERNAL — not for client: {{ticket.number}} escalated to compliance by {{agent.name}} on {{today}}. " +
      "Requester {{requester.name}} ({{requester.firstName}}) has not been told; hold client-facing replies " +
      "until compliance responds on this thread.",
  },
];

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

/**
 * Create-if-missing, idempotent, and loud about what it left alone.
 *
 * `createMany({ skipDuplicates: true })` would be one statement, but it would not say WHICH macros it
 * skipped — and "the deploy did not change the wording you are looking at" is exactly what an
 * operator needs to read in the job log when a stored body does not match this file. So each key is
 * checked and each skip is named.
 *
 * No audit rows: the seeder runs with no actor and this is reference data, the same as the queues and
 * the SLA policies above. Runtime edits are the audited path.
 */
export async function seedMacros(
  db: DbTx,
  queueIds: Record<QueueKey, string>,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  const skipped: string[] = [];

  for (const m of MACRO_SEED) {
    const existing = await db.macro.findUnique({ where: { key: m.key }, select: { id: true } });
    if (existing) {
      skipped.push(m.key);
      continue;
    }
    const queueId = m.queueKey === null ? null : queueIds[m.queueKey];
    await db.macro.create({
      data: {
        key: m.key,
        title: m.title,
        queueId,
        body: m.body,
        channel: m.channel,
        disclaimerKey: m.disclaimerKey,
        isActive: m.isActive,
        sortOrder: m.sortOrder,
      },
    });
    created++;
  }

  if (skipped.length > 0) {
    console.log(
      `macros: kept ${skipped.length} existing macro${skipped.length === 1 ? "" : "s"} unchanged ` +
        `(create-if-missing; edit wording at /admin/macros): ${skipped.join(", ")}`,
    );
  }
  return { created, skipped: skipped.length };
}
