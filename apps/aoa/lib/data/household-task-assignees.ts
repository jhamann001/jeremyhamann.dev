import "server-only";
import { createHash } from "node:crypto";

export type HouseholdTaskAssigneeOption = { token: string; label: string; type: "USER" | "QUEUE" };
export type HouseholdTaskAssigneeSource = { source_id: string; assignee_type: "USER" | "QUEUE"; assignee_name: string };

/** Call only with the complete, RLS-visible household owner set. Source IDs never leave the server. */
export function householdTaskAssignees(canonicalSourceKey: string, sources: HouseholdTaskAssigneeSource[]) {
  const owners = sources.map(source => ({
    sourceId: source.source_id.slice(0, 15),
    type: source.assignee_type,
    label: source.assignee_name.trim(),
    token: createHash("sha256").update(JSON.stringify([
      "household-task-assignee-v1", canonicalSourceKey.slice(0, 15), source.assignee_type, source.source_id.slice(0, 15),
    ])).digest("hex"),
  }));
  const labelGroups = new Map<string, typeof owners>();
  for (const owner of owners) {
    const key = `${owner.type}:${owner.label.toLowerCase()}`;
    const group = labelGroups.get(key) ?? [];
    group.push(owner);
    labelGroups.set(key, group);
  }
  for (const group of labelGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    group.forEach((owner, index) => { owner.label = `${owner.label} (${index + 1})`; });
  }
  return owners.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label) || a.token.localeCompare(b.token));
}
