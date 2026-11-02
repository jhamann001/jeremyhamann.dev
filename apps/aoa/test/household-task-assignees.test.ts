import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { householdTaskAssignees } from "@/lib/data/household-task-assignees";

const person = { source_id: "005SYN000000001", assignee_type: "USER" as const, assignee_name: "Avery Example" };

describe("household-scoped source assignment identities", () => {
  it("normalizes 15/18-character source IDs, retains identity across renames and scopes tokens to the canonical household", () => {
    const [initial] = householdTaskAssignees("001SYN000000001", [person]);
    const [renamed] = householdTaskAssignees("001SYN000000001AAA", [{ ...person,
      source_id: `${person.source_id}AAA`, assignee_name: "Kamron O'Hara" }]);
    expect(initial.token).toMatch(/^[a-f0-9]{64}$/);
    expect(renamed.token).toBe(initial.token);
    expect(renamed.label).toBe("Kamron O'Hara");
    expect(householdTaskAssignees("001SYN000000002", [person])[0].token).not.toBe(initial.token);
  });

  it("keeps same-name owners distinct and deterministically disambiguates within source type", () => {
    const people = [person, { ...person, source_id: "005SYN000000002" }];
    const queue = { source_id: "00GSYN000000001", assignee_type: "QUEUE" as const, assignee_name: "Avery Example" };
    const owners = householdTaskAssignees("001SYN000000001", [people[1], queue, people[0]]);
    expect(new Set(owners.map(owner => owner.token)).size).toBe(3);
    expect(owners.filter(owner => owner.type === "USER").map(owner => owner.label)).toEqual(["Avery Example (1)", "Avery Example (2)"]);
    expect(owners.find(owner => owner.type === "QUEUE")?.label).toBe("Avery Example");
    expect(owners).toEqual(householdTaskAssignees("001SYN000000001", [people[0], queue, people[1]]));
  });
});
