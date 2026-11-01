/**
 * Pure tests for the staff-account inputs. No database: the schema and
 * the machine-identity list are the parts of this slice that can be wrong without any row existing.
 * The transactional behaviour is proven in `users.actions.integration.test.ts`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { SetUserActiveInput } from "@/types/domain";
import { INTEGRATION_ACTOR_EMAIL, JOB_ACTOR_EMAIL } from "@/lib/audit";
import { MACHINE_ACTOR_EMAILS, setUserActiveSchema } from "@/server/users";

describe("setUserActiveSchema", () => {
  it("its output is exactly SetUserActiveInput", () => {
    expectTypeOf<typeof setUserActiveSchema._zod.output>().toEqualTypeOf<SetUserActiveInput>();
  });

  it("accepts a well-formed deactivation and a well-formed reactivation", () => {
    expect(setUserActiveSchema.parse({ userId: "ckabc123", isActive: false })).toEqual({
      userId: "ckabc123",
      isActive: false,
    });
    expect(setUserActiveSchema.parse({ userId: "it_user_1", isActive: true })).toEqual({
      userId: "it_user_1",
      isActive: true,
    });
  });

  it("trims the reason and keeps it optional", () => {
    expect(setUserActiveSchema.parse({ userId: "u1", isActive: false, reason: "  left the firm  " })).toEqual({
      userId: "u1",
      isActive: false,
      reason: "left the firm",
    });
    expect(setUserActiveSchema.parse({ userId: "u1", isActive: false })).not.toHaveProperty("reason");
  });

  it("refuses an id shape that is not a cuid / seed-style token", () => {
    for (const userId of ["", " ", "a".repeat(65), "with space", "semi;colon", "../../etc/passwd", "a@b.com"]) {
      expect(() => setUserActiveSchema.parse({ userId, isActive: false }), userId).toThrow();
    }
  });

  it("refuses a non-boolean isActive and an over-long reason", () => {
    expect(() => setUserActiveSchema.parse({ userId: "u1", isActive: "false" })).toThrow();
    expect(() => setUserActiveSchema.parse({ userId: "u1" })).toThrow();
    expect(() => setUserActiveSchema.parse({ userId: "u1", isActive: false, reason: "x".repeat(501) })).toThrow();
    expect(() => setUserActiveSchema.parse({ userId: "u1", isActive: false, reason: "x".repeat(500) })).not.toThrow();
  });

  it("refuses a non-object input outright", () => {
    for (const input of [null, undefined, "u1", 7, []]) {
      expect(() => setUserActiveSchema.parse(input)).toThrow();
    }
  });
});

describe("MACHINE_ACTOR_EMAILS", () => {
  it("is exactly the two seeded machine identities", () => {
    expect([...MACHINE_ACTOR_EMAILS].sort()).toEqual([INTEGRATION_ACTOR_EMAIL, JOB_ACTOR_EMAIL].sort());
  });

  it("names real addresses, so a lookup by email can never match a staff account by accident", () => {
    for (const email of MACHINE_ACTOR_EMAILS) {
      expect(email).toMatch(/^[a-z]+@wm-helpdesk\.local$/);
    }
  });
});
