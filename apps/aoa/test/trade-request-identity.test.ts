import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { indexAoaAccounts, matchIdentity, normalizeEmail, resolveActorIdentity } from "@/lib/trade-requests/identity";

const ROW = { id: "00000000-0000-4000-8000-000000000101", email: "first@example.test", name: "First Actor", role: "advisor", is_active: false, slack_user_id: null };

describe("Trade Request identity matching", () => {
  it("normalizes an email by trimming and lower-casing", () => {
    expect(normalizeEmail(" A@Example.TEST ")).toBe("a@example.test");
  });

  it("matches one AOA account on the normalized email", () => {
    const account = { email: "Person@Example.test", role: "ADVISOR" };
    expect(matchIdentity("person@example.test", indexAoaAccounts([account]), 1)).toEqual({ status: "matched", account });
  });

  it("reports missing when no AOA account has the email", () => {
    expect(matchIdentity("nobody@example.test", indexAoaAccounts([{ email: "other@example.test" }]), 1)).toEqual({ status: "missing", account: null });
  });

  it("reports ambiguous when two AOA accounts share a normalized email", () => {
    const index = indexAoaAccounts([{ email: "Dup@example.test" }, { email: "dup@example.test" }]);
    expect(matchIdentity("dup@example.test", index, 1)).toEqual({ status: "ambiguous", account: null });
  });

  it("reports ambiguous when two identities share an email", () => {
    expect(matchIdentity("pair@example.test", indexAoaAccounts([{ email: "pair@example.test" }]), 2)).toEqual({ status: "ambiguous", account: null });
  });

  it("creates an inactive advisor identity for a first-time actor and returns the re-selected row", async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
    const identity = await resolveActorIdentity(tx, { email: " First@Example.TEST ", name: "First Actor" });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("'advisor', false");
    expect(values).toEqual(["first@example.test", "First Actor"]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(identity).toEqual({ id: ROW.id, email: ROW.email, name: ROW.name, role: "advisor", isActive: false, slackUserId: null });
  });
});
