/**
 * The SYSTEM message registry — pure, layer L1.
 *
 * One lookup, total over (brand × kind), so no caller can reach a half-configured template and no
 * brand can quietly lose one of the two messages. `renderSystemMessage` returns the STORED body: the
 * template text with its disclaimer already appended, exactly as `addPublicReply` builds a staff reply,
 * because the Comment row has to be the record of what the client received.
 */
import type { DisclaimerKey, TicketBrand } from "@/types/domain";
import { TICKET_BRANDS } from "@/types/domain";
import { appendDisclaimer } from "@/lib/disclaimers";
import { CEDAR_RIDGE_DIRECT_SYSTEM_TEMPLATES } from "@/lib/email/templates/system/cedar-ridge-direct";
import { CEDAR_RIDGE_WEALTH_SYSTEM_TEMPLATES } from "@/lib/email/templates/system/cedar-ridge-wealth";
import { SYSTEM_MESSAGE_KINDS } from "@/lib/email/templates/system/types";
import type {
  SystemMessageKind,
  SystemMessageTemplate,
  SystemMessageTemplateSet,
  SystemMessageVars,
} from "@/lib/email/templates/system/types";

export { SYSTEM_MESSAGE_KINDS } from "@/lib/email/templates/system/types";
export type {
  SystemMessageKind,
  SystemMessageTemplate,
  SystemMessageTemplateSet,
  SystemMessageVars,
} from "@/lib/email/templates/system/types";

/** Every SYSTEM template, by brand then kind. Frozen: a caller cannot mutate the firm's wording at runtime. */
export const SYSTEM_MESSAGE_TEMPLATES: Readonly<Record<TicketBrand, SystemMessageTemplateSet>> = Object.freeze({
  CEDAR_RIDGE_WEALTH: CEDAR_RIDGE_WEALTH_SYSTEM_TEMPLATES,
  CEDAR_RIDGE_DIRECT: CEDAR_RIDGE_DIRECT_SYSTEM_TEMPLATES,
}) as Readonly<Record<TicketBrand, SystemMessageTemplateSet>>;

export function systemMessageTemplate(brand: TicketBrand, kind: SystemMessageKind): SystemMessageTemplate {
  return SYSTEM_MESSAGE_TEMPLATES[brand][kind];
}

export type RenderedSystemMessage = {
  /** The body as it is STORED on the Comment row: template text + "\n\n---\n" + the disclaimer text. */
  body: string;
  /** The disclaimer key recorded on the Comment row beside it. Never `NONE` for a PUBLIC row. */
  disclaimerKey: DisclaimerKey;
};

/**
 * The stored body and disclaimer key for one SYSTEM message.
 *
 * The subject is NOT decided here: `enqueueDelivery` renders `[HD-<number>] <ticket subject>` through
 * `renderOutbound`, so an acknowledgement threads with the client's own message in their mail client
 * instead of starting a second conversation about the same request.
 */
export function renderSystemMessage(
  brand: TicketBrand,
  kind: SystemMessageKind,
  vars: SystemMessageVars,
): RenderedSystemMessage {
  const template = systemMessageTemplate(brand, kind);
  return {
    body: appendDisclaimer(template.body(vars), template.disclaimerKey),
    disclaimerKey: template.disclaimerKey,
  };
}

/** Every (brand, kind) pair, for the parity tests and the messages-file check. */
export function everySystemTemplate(): SystemMessageTemplate[] {
  return TICKET_BRANDS.flatMap((brand) => SYSTEM_MESSAGE_KINDS.map((kind) => systemMessageTemplate(brand, kind)));
}
