/**
 * CEDAR_RIDGE_WEALTH SYSTEM message bodies — DRAFT wording, pending the owner's and the CCO's approval.
 *
 * The literal text below is mirrored in the build record and
 * the build record, and a test in this directory asserts the two copies agree.
 * That is the acceptance criterion the wave states in §0.4: what is approved in the messages file is
 * byte-for-byte what would be transmitted, so approval is meaningful.
 *
 * Nothing here can be sent: `AUTO_ACK_ENABLED` and `RESOLVED_NOTICE_ENABLED` are unset everywhere, and
 * `maybeSendAutoAcknowledgement` / `maybeSendResolvedNotice` return null without them.
 *
 * Three wording choices that are deliberate rather than stylistic:
 *
 *  1. **The receipt says outright that it is not an answer.** An automatic acknowledgement that reads
 *     like a human reply is how a client concludes the desk has looked at their wire instruction when
 *     nobody has. The SYSTEM comment never stamps `firstRespondedAt` for the same reason, and the two
 *     facts should agree in the client's inbox as well as in the ledger.
 *  2. **It names the reference and asks for it to stay in the subject.** That is the string the inbound
 *     path threads on when the reply token is unavailable, so the sentence is operational, not decorative.
 *  3. **It carries the do-not-email-sensitive-data line in the body, not only in the disclaimer.** The
 *     disclaimer is read as boilerplate; the first message a client receives from the desk is the one
 *     moment the request will actually be read.
 */
import type { SystemMessageTemplateSet, SystemMessageVars } from "@/lib/email/templates/system/types";

export function cedarridgewealthAutoAckBody({ ticketNumber }: SystemMessageVars): string {
  return [
    `Thank you for contacting Cedar Ridge Wealth Client Service. Your message has arrived and we have opened reference **HD-${ticketNumber}** for it.`,
    "",
    "**What happens next**",
    "",
    "- A member of your service team reviews every request in the order it arrives, and sooner when it is time sensitive.",
    "- You will hear back from a person, with an answer or with an update on what we are doing.",
    "- This receipt confirms only that your message reached us. It is not an answer, and no one has reviewed your request yet.",
    "",
    "**If you need to add anything**",
    "",
    `Reply to this email and your message joins the same request. Please keep **HD-${ticketNumber}** in the subject line so it reaches the right place.`,
    "",
    "Please do not send account numbers, Social Security numbers, or other sensitive personal details by email. If we need something like that, we will tell you a secure way to send it.",
  ].join("\n");
}

export function cedarridgewealthResolvedNoticeBody({ ticketNumber }: SystemMessageVars): string {
  return [
    `We have marked reference **HD-${ticketNumber}** as resolved.`,
    "",
    "**What this means**",
    "",
    "- The work this request asked for is complete, and there is nothing further for you to do.",
    "- The full record of the request, including everything we sent you, stays on file with us.",
    "",
    "**If this is not resolved**",
    "",
    `Reply to this email, keeping **HD-${ticketNumber}** in the subject line, and the request reopens with your reply attached to it. You do not need to start a new one.`,
    "",
    "Please do not send account numbers, Social Security numbers, or other sensitive personal details by email.",
  ].join("\n");
}

export const CEDAR_RIDGE_WEALTH_SYSTEM_TEMPLATES: SystemMessageTemplateSet = Object.freeze({
  AUTO_ACK: Object.freeze({
    kind: "AUTO_ACK",
    brand: "CEDAR_RIDGE_WEALTH",
    disclaimerKey: "GENERAL_SERVICE",
    body: cedarridgewealthAutoAckBody,
  }),
  RESOLVED_NOTICE: Object.freeze({
    kind: "RESOLVED_NOTICE",
    brand: "CEDAR_RIDGE_WEALTH",
    disclaimerKey: "GENERAL_SERVICE",
    body: cedarridgewealthResolvedNoticeBody,
  }),
}) as SystemMessageTemplateSet;
