import { describe, expect, it } from "vitest";
import { rememberTaskDisclosure, TASKS_OPEN_ID } from "@/components/client-portrait/task-disclosures";

describe("household task disclosure memory", () => {
  it("retains independent rows when closing and reopening the outer card", () => {
    const both = ["synthetic-a", "synthetic-b", TASKS_OPEN_ID];
    const closed = rememberTaskDisclosure(both, TASKS_OPEN_ID, false);
    expect(closed).toEqual(["synthetic-a", "synthetic-b"]);
    expect(rememberTaskDisclosure(closed, TASKS_OPEN_ID, true)).toEqual(both);
    expect(rememberTaskDisclosure(both, "synthetic-a", false)).toEqual(["synthetic-b", TASKS_OPEN_ID]);
  });

  it("never evicts the outer card when more rows are expanded than navigation memory allows", () => {
    let ids = [TASKS_OPEN_ID];
    for (let index = 0; index < 30; index++) ids = rememberTaskDisclosure(ids, `synthetic-${index}`, true);
    expect(ids).toHaveLength(20);
    expect(ids.at(-1)).toBe(TASKS_OPEN_ID);
    expect(ids.slice(0, -1)).toEqual(Array.from({ length: 19 }, (_, index) => `synthetic-${index + 11}`));
  });

  it("remembers the latest expansion once and makes room for reopening a closed outer card", () => {
    const manyRows = Array.from({ length: 20 }, (_, index) => `synthetic-${index}`);
    const remembered = rememberTaskDisclosure(manyRows, "synthetic-1", true);
    expect(remembered).toHaveLength(19);
    expect(remembered.at(-1)).toBe("synthetic-1");
    expect(remembered.filter(id => id === "synthetic-1")).toHaveLength(1);
    expect(rememberTaskDisclosure(remembered, TASKS_OPEN_ID, true)).toHaveLength(20);
  });
});
