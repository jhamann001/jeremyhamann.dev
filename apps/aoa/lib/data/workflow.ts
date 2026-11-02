import type { DocCatalog, WorkflowSeed } from "./workflow-types";
import {
  DECISIONS,
  NUDGE_QUEUE,
  NUDGE_TEMPLATES,
  PIPELINE_STATS,
} from "@/lib/mock/workflow";
import { DOCS, DOC_NEEDS } from "@/lib/mock/apex-docs";
import { demoMode } from "@/lib/demo/mode";
import { demoWorkflow } from "@/lib/demo/samples/workflow";

// Workflow data-access seam (Phase C, TDD §3, ADR-1).
//
// NOTE: `lib/data` otherwise holds REAL, RLS-scoped reads (see households.ts via
// `withUserScope`). This Workflow seam is deliberately MOCK-backed for Phase C —
// it keeps the future signature shape so Phase D can swap the body to a real read
// (app.decision/app.task/app.nudge) without touching any component or the store.

export function getWorkflowSeed(now?: Date): WorkflowSeed {
  // The public demo's decisions and nudges are its showcase households' (lib/demo/samples), keyed to its own clients
  // and dated from `now`: the seed's clock where the caller has it (demoSampleNow, server side), else the wall clock.
  const demo = demoMode() ? demoWorkflow(now) : null;
  return {
    decisions: demo?.decisions ?? DECISIONS,
    nudges: demo?.nudges ?? NUDGE_QUEUE,
    templates: NUDGE_TEMPLATES,
    stats: PIPELINE_STATS,
  };
}

export function getDocCatalog(): DocCatalog {
  return { docs: DOCS, needs: DOC_NEEDS };
}

// Keyword-scored stub (Phase E AI seam, ADR-6). Lowercases the text and returns
// the deduped union of DOC_NEEDS codes for every keyword substring-matched.
// Phase E replaces this with a model call (decision text → required Apex forms).
export function detectNeed(text: string): string[] {
  const haystack = text.toLowerCase();
  const codes = new Set<string>();
  for (const [keyword, mapped] of Object.entries(DOC_NEEDS)) {
    if (haystack.includes(keyword)) {
      for (const code of mapped) codes.add(code);
    }
  }
  return [...codes];
}
