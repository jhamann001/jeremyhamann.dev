/**
 * Firm-approved disclaimer texts — pure, layer L1.
 *
 * Disclaimers are CODE, versioned in git, never a mutable table. `addPublicReply` appends the text into
 * the stored Comment.body so the row is exactly what the client received.
 *
 * CONTRACT-GAP: the contract fixes the keys and the append format but supplies no approved wording. The
 * texts below are conservative, firm-neutral drafts; compliance sign-off of the wording is a release item,
 * and any change is a reviewed commit.
 */
import { DISCLAIMER_KEYS } from "@/types/domain";
import type { DisclaimerKey } from "@/types/domain";

export const DISCLAIMERS: Readonly<Record<DisclaimerKey, { label: string; text: string }>> = Object.freeze({
  NONE: { label: "None", text: "" },
  GENERAL_SERVICE: {
    label: "General service",
    text:
      "This message was sent by your service team in response to a request on your account. It is intended " +
      "solely for the addressee and may contain confidential information; if you received it in error, please " +
      "notify us and delete it. Nothing in this message constitutes investment, tax, or legal advice, or an " +
      "offer or solicitation to buy or sell any security. Please do not reply with account numbers, Social " +
      "Security numbers, or other sensitive personal information.",
  },
  WIRE_VERIFICATION: {
    label: "Wire verification",
    text:
      "For your protection, all wire and third-party money-movement instructions are verbally verified by a " +
      "call to the telephone number on file before any funds are released. We will never ask you to change " +
      "payment or wire instructions by email. If you receive instructions that appear to come from us and you " +
      "did not initiate them, do not act on them; call your service team at the number on your statement.",
  },
  TAX_DOCUMENT: {
    label: "Tax document",
    text:
      "Tax documents, including Forms 1099, are produced by the account custodian and may be corrected or " +
      "reissued after they first become available. Please review them with your tax professional before " +
      "filing. This message does not constitute tax advice.",
  },
  NOT_TAX_OR_LEGAL_ADVICE: {
    label: "Not tax or legal advice",
    text:
      "We do not provide tax or legal advice. Any discussion of tax matters, including tax-loss harvesting, " +
      "is general in nature, may not apply to your particular circumstances, and should be reviewed with " +
      "your tax or legal professional before you act on it.",
  },
  INVESTMENT_ADVICE: {
    label: "Investment advice",
    text:
      "This communication is provided by a registered investment adviser for informational purposes and " +
      "reflects our views as of the date sent. Investing involves risk, including the possible loss of " +
      "principal, and past performance does not guarantee future results. Any recommendation is based on the " +
      "information and objectives you have shared with us; please tell us promptly if your financial " +
      "situation or goals have changed.",
  },
});

/** Every key a PUBLIC reply may carry: DISCLAIMER_KEYS without "NONE". */
export const PUBLIC_DISCLAIMER_KEYS: readonly DisclaimerKey[] = Object.freeze(
  DISCLAIMER_KEYS.filter((k): k is DisclaimerKey => k !== "NONE"),
);

/** NONE → body unchanged; otherwise `${body.trimEnd()}\n\n---\n${DISCLAIMERS[key].text}`. */
export function appendDisclaimer(body: string, key: DisclaimerKey): string {
  if (key === "NONE") return body;
  return `${body.trimEnd()}\n\n---\n${DISCLAIMERS[key].text}`;
}
