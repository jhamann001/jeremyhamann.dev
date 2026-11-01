/**
 * The demo's AI provider (Decision 8: no live model in the demo). Built on the test fake, so the prompt is
 * built by the same function the Vertex provider uses: what a model would have been sent is exactly the
 * public thread, never an internal note. The draft is a canned reply for the ticket's category; it fills
 * the composer, and a person still edits and sends it.
 */
import { createFakeAiProvider } from "@/lib/ai/fake";
import type { AiDraftProvider } from "@/lib/ai/provider";
import type { TicketCategory } from "@/types/domain";

export const DEMO_AI_MODEL = "demo-canned-drafts";

/** The middle of each canned draft. The greeting and sign-off are added around it. */
const DRAFT_BY_CATEGORY: Record<TicketCategory, string> = {
  WIRE_TRANSFER:
    "We have your wire request. Before any money moves we will confirm the receiving bank's instructions with you by phone, on a number we already have for you.",
  ACAT: "Your transfer is with the delivering firm. Transfers like this usually settle within five to seven business days, and we will let you know as soon as the assets arrive.",
  TRADE_CORRECTION: "Thank you for flagging this trade. We are reviewing it with our trading desk and will correct it at no cost to you if it was booked in error.",
  CASH_MOVEMENT: "We have your request to move cash and will submit it today. It should arrive within two business days.",
  PORTAL_RESET: "We have sent you a link to reset your sign-in. It expires in an hour, so please use it soon.",
  TAX_DOCUMENT: "Your tax documents post to the Documents tab as the custodian releases them. We are checking on yours now.",
  ADDRESS_CHANGE: "We can update your mailing address once we have confirmed it with you by phone. We will send a confirmation to both addresses.",
  REBALANCING: "Thank you. Your advisor is reviewing your allocation against your model and will be in touch about any trades.",
  PLANNING_UPDATE: "Thank you for the update. We will reflect it in your plan and walk through it with you at your next review.",
  TAX_LOSS_HARVESTING: "We will review your taxable accounts for losses we could harvest and come back to you with what we find.",
  OTHER: "Thanks for reaching out. We are looking into this and will come back to you shortly.",
  ACCOUNT_CLOSURE: "We have your request and will confirm the account has no remaining balance before we close it.",
  BENEFICIARY_TOD: "We have sent the beneficiary form for your signature. Once it is back we will record the change and confirm it with you.",
  RETURNED_CHECK: "A check we sent you came back to us. Could you confirm your mailing address so we can reissue it?",
  RETURNED_MAIL: "Some of our mail to you came back. Could you confirm your mailing address?",
  PASSKEY_LOGIN: "A passkey belongs to the device that created it, so a new phone needs a new one. We have sent you a link to set it up.",
  IDENTITY_VERIFICATION: "To make this change we need a copy of a government-issued ID. You can upload it through the secure portal.",
  COMPLAINT: "I am sorry for the trouble this has caused. I have passed your concerns to our compliance team and will follow up with you personally.",
  RETIREMENT_DISTRIBUTION: "We have your distribution request and will confirm the tax withholding with you before it is paid.",
  COST_BASIS: "Cost basis follows the assets from the delivering firm, usually within a few days. We are checking on it for you.",
  VOICEMAIL_CALLBACK: "Thank you for your message. We tried you back and will try again this afternoon.",
  STATEMENT_REQUEST: "Your past statements are in the Documents tab. We will pull together the ones you need.",
};

export function demoDraftText(category: TicketCategory, requesterName: string | null | undefined): string {
  const first = requesterName?.trim().split(/\s+/)[0];
  return `${first ? `Hello ${first},` : "Hello,"}\n\n${DRAFT_BY_CATEGORY[category]}\n\nKind regards,`;
}

export function createDemoAiProvider(): AiDraftProvider {
  return {
    name: "demo",
    async draft(input) {
      const fake = createFakeAiProvider({
        model: DEMO_AI_MODEL,
        text: demoDraftText(input.ticket.category, input.ticket.requesterName),
      });
      return fake.draft(input);
    },
  };
}
