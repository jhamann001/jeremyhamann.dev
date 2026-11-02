import type { TransferContext } from "@/lib/data/transfer-context";

// Temperature fixtures (Phase Asset Transfer T4, TDD ADR-10) — ALL INVENTED,
// keyed by the seed `client_sf_id`s (Stone / Nguyen / Okafor / Walker / Patel;
// prisma/seed.ts). No real client data, no mockup personas. Phase E replaces
// this file's consumers with real synthesis; the fixtures then retire.
//
// Register shape (WO ticket scope): at least one Sensitive/red, one
// Done- or Smooth-green, and one seed client deliberately ABSENT — C-2
// (Jo Stone, DEMO-T-0004) has no entry, so the no-context path (card hidden)
// is exercisable against seed data.

export const TRANSFER_CONTEXT: Record<string, TransferContext> = {
  // Sam Stone — DEMO-T-0001 (DISCOVERY). Red: sensitive family moment.
  "C-1": {
    tone: "Sensitive",
    narrative:
      "Recent calls reference an estate settlement in progress — keep outreach gentle and let Sam set the pace. A receiving account is ready whenever the family is.",
    sources: ["Notewell", "Email"],
  },
  // Minh Nguyen — DEMO-T-0003 (DECISION). Gold: watchful, worksheet pending.
  "C-3": {
    tone: "Watchful",
    narrative:
      "Engaged but deliberate — Minh asked twice about tax drag on the appreciated lots. The asset-decision worksheet is the unlock; expect questions before signatures.",
    sources: ["Slack", "Email"],
  },
  // Ada Okafor — DEMO-T-0002 (DISCOVERY). Green: smooth, statements arriving.
  "C-4": {
    tone: "Smooth",
    narrative:
      "Statements are arriving without chasing and Ada responds same-day. Nothing sensitive in the record — proceed at the normal cadence.",
    sources: ["Egnyte", "Email"],
  },
  // Neil Walker — DEMO-T-0006/0008 (ACCOUNTS_OPEN / IN_TRANSFER). Red: stalled thread.
  "C-5": {
    tone: "Stalled",
    narrative:
      "The Roth paperwork thread has sat quiet for a week and the last portal login predates it. Worth a call touch before the ACAT window — don't let the momentum cool.",
    sources: ["Notewell", "Slack", "Email"],
  },
  // Asha Patel — DEMO-T-0005/0007 (DECISION / ACCOUNTS_OPEN). Green: done vibe.
  "C-6": {
    tone: "Done",
    narrative:
      "Decisions confirmed on the review call and Asha signed the account packet same day. Remaining steps are ours, not hers — no client action outstanding.",
    sources: ["Notewell", "Egnyte"],
  },
  // "C-2" (Jo Stone) intentionally ABSENT — the no-context client (see header).
};
