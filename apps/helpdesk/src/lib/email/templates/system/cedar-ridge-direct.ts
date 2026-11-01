/**
 * CEDAR_RIDGE_DIRECT SYSTEM message bodies — DRAFT wording, pending the owner's and the CCO's approval.
 *
 * Same two messages, same rules, different voice and a different sending identity
 * (`BRAND_IDENTITIES.CEDAR_RIDGE_DIRECT`). The substance is held identical on purpose — the receipt still
 * says it is not an answer, still names the reference, and still carries the sensitive-data line —
 * because those three sentences are the ones with a compliance consequence, and a brand's tone is not
 * a reason to drop any of them.
 *
 * Mirrored in the build record and `resolved-notice.md`; a test asserts
 * the copies agree byte for byte.
 */
import type { SystemMessageTemplateSet, SystemMessageVars } from "@/lib/email/templates/system/types";

export function cedarRidgeDirectAutoAckBody({ ticketNumber }: SystemMessageVars): string {
  return [
    `Thanks for getting in touch with Cedar Ridge Direct Support. We have your message, and it is now reference **HD-${ticketNumber}**.`,
    "",
    "**What happens next**",
    "",
    "- Support works through requests in the order they arrive, and sooner when something is time sensitive.",
    "- A person will reply — with an answer, or with an update on what we are doing.",
    "- This receipt only confirms that your message reached us. It is not an answer, and nobody has reviewed your request yet.",
    "",
    "**If you need to add anything**",
    "",
    `Reply to this email and your message joins the same request. Please keep **HD-${ticketNumber}** in the subject line so it reaches the right place.`,
    "",
    "Please do not send account numbers, Social Security numbers, or other sensitive personal details by email. If we need something like that, we will tell you a secure way to send it.",
  ].join("\n");
}

export function cedarRidgeDirectResolvedNoticeBody({ ticketNumber }: SystemMessageVars): string {
  return [
    `Reference **HD-${ticketNumber}** is now marked resolved.`,
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

export const CEDAR_RIDGE_DIRECT_SYSTEM_TEMPLATES: SystemMessageTemplateSet = Object.freeze({
  AUTO_ACK: Object.freeze({
    kind: "AUTO_ACK",
    brand: "CEDAR_RIDGE_DIRECT",
    disclaimerKey: "GENERAL_SERVICE",
    body: cedarRidgeDirectAutoAckBody,
  }),
  RESOLVED_NOTICE: Object.freeze({
    kind: "RESOLVED_NOTICE",
    brand: "CEDAR_RIDGE_DIRECT",
    disclaimerKey: "GENERAL_SERVICE",
    body: cedarRidgeDirectResolvedNoticeBody,
  }),
}) as SystemMessageTemplateSet;
