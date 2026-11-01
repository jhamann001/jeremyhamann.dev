// @vitest-environment node

import { describe, expect, it } from "vitest";
import { authorizePersona } from "./persona-auth";
import { canonicalPersonaEmail, PERSONAS } from "./personas";
import { loadUniverse, PERSONA_STAFF_IDS, staffEmail, staffRole } from "./universe";

describe("demo personas", () => {
  it("are the universe's persona staff, with the roles the seed gives them", () => {
    const universe = loadUniverse();
    const staff = PERSONA_STAFF_IDS.map((id) => universe.staff.find((s) => s.id === id)!);
    // Same people in any order: the sign-in page lists them in its own order.
    const fromUniverse = staff.map((s) => `${staffEmail(s)}|${s.name}|${staffRole(s)}`).sort();
    expect(PERSONAS.map((p) => `${p.email}|${p.name}|${p.role}`).sort()).toEqual(fromUniverse);
    expect(new Set(PERSONAS.map((p) => p.role))).toEqual(new Set(["ADMIN", "USER", "ADVISOR"]));
  });

  it("recognize a persona email in any letter case, and nothing else", () => {
    expect(canonicalPersonaEmail("  Marco.Ferreira@EXAMPLE.com ")).toBe("marco.ferreira@example.com");
    expect(canonicalPersonaEmail("marco.ferreira@example.org")).toBeNull();
    expect(canonicalPersonaEmail("helen.carver@example.com")).toBeNull();
  });
});

describe("persona sign-in", () => {
  const rows = new Map([
    ["jordan.reyes@example.com", { email: "jordan.reyes@example.com", name: "Jordan Reyes", active: true }],
    ["rachel.moss@example.com", { email: "rachel.moss@example.com", name: "Rachel Moss", active: false }],
    ["helen.carver@example.com", { email: "helen.carver@example.com", name: "Helen Carver", active: true }],
  ]);
  const findUser = async (email: string) => rows.get(email) ?? null;

  it("signs in an active persona, looked up by its canonical email", async () => {
    expect(await authorizePersona("JORDAN.REYES@example.com", findUser)).toEqual({ email: "jordan.reyes@example.com", name: "Jordan Reyes" });
  });

  it("refuses other staff, inactive personas and anything that isn't an email", async () => {
    expect(await authorizePersona("helen.carver@example.com", findUser)).toBeNull();
    expect(await authorizePersona("rachel.moss@example.com", findUser)).toBeNull();
    expect(await authorizePersona("marco.ferreira@example.com", findUser)).toBeNull(); // no account
    expect(await authorizePersona(undefined, findUser)).toBeNull();
    expect(await authorizePersona(["jordan.reyes@example.com"], findUser)).toBeNull();
  });
});
