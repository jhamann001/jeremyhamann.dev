import { getDocCatalog } from "@/lib/data/workflow";
import { INTENDED_ACTIONS } from "@/lib/mock/intended-actions";
import type {
  ClientState,
  DocCatalog,
  IntendedAction,
  RequirementCondition,
  ResolvedRequirement,
} from "@/lib/data/workflow-types";

// Pure requirements resolver (ticket, Phase 1). Maps an intended action +
// ops-entered client state to the exact bundle of Apex forms, reusing the
// DocForm catalog for name / supporting-doc / signers. No feed, no persistence.

// Forms where a joint registration adds a second signature line.
const JOINT_SIGNER_FORMS = new Set(["acat", "wire", "journal", "toa"]);

export function getIntendedActions(): IntendedAction[] {
  return Object.values(INTENDED_ACTIONS);
}

function evalCondition(cond: RequirementCondition, s: ClientState): boolean {
  switch (cond.field) {
    case "hasLinkedBank":
      return s.hasLinkedBank === cond.equals;
    case "registration":
      return cond.in.includes(s.registration);
    case "ownership":
      return (s.ownership ?? "single") === cond.equals;
  }
}

function isJoint(s: ClientState): boolean {
  return s.registration === "joint" || s.ownership === "joint";
}

export function resolveRequirements(
  actionId: string,
  clientState: ClientState,
  catalog: DocCatalog = getDocCatalog(),
): ResolvedRequirement[] {
  const action = INTENDED_ACTIONS[actionId];
  if (!action) return [];
  const out: ResolvedRequirement[] = [];
  for (const req of action.requires) {
    if (req.when && !evalCondition(req.when, clientState)) continue;
    const form = catalog.docs[req.code];
    const signers = [...(form?.signers ?? [])];
    if (isJoint(clientState) && JOINT_SIGNER_FORMS.has(req.code)) {
      signers.push("Joint account holder");
    }
    out.push({
      code: req.code,
      name: form?.name ?? req.code,
      reason: req.reason ?? `${form?.name ?? req.code} — required for ${action.label}`,
      supporting: form?.supporting,
      signers,
    });
  }
  return out;
}
