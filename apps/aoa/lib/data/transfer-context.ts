import { TRANSFER_CONTEXT } from "@/lib/mock/transfer-context";

// Client-temperature seam (Phase Asset Transfer T4, TDD ticket ADR-10).
//
// Temperature (tone + narrative + source chips) is Phase E AI synthesis over
// ingested comms — it gets NO schema. This seam serves invented fixtures keyed
// by `client_sf_id` (lib/mock/transfer-context.ts), the Phase C/F mock-seam
// idiom (see lib/data/workflow.ts). PHASE E CONTRACT: swap this body for the
// real synthesis read — the signature is frozen (TDD §4); no component changes.
// The TemperatureCard wears `PreviewBadge` "Preview · Phase E synthesis" for
// exactly as long as this body is mock.

export type TransferContext = {
  /** Tone word — Sensitive/Stalled render red, Done/Smooth green, else gold. */
  tone: string;
  /** One-paragraph synthesized narrative (INVENTED fixture text today). */
  narrative: string;
  /** Source chips — where the synthesis pulled from (Notewell/Egnyte/Slack/Email). */
  sources: string[];
};

/**
 * Temperature context for a client, or null when there is none (prospects
 * without a `client_sf_id`, and clients with no synthesized context — the
 * card hides). Mock body now; Phase E replaces it (ADR-10).
 */
export function getTransferContext(
  clientSfId: string | null,
): TransferContext | null {
  if (!clientSfId) return null;
  return TRANSFER_CONTEXT[clientSfId] ?? null;
}
