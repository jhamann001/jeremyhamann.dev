/**
 * Presence arithmetic, without a database.
 *
 * Presence is derived from `TICKET_VIEWED` rows, so the only logic worth pinning is the part that
 * turns a stream of audit rows into "who is here": the window, one row per person, and the two people
 * who must never appear — the viewer themselves, and anybody who has been deactivated.
 */
import { describe, expect, it } from "vitest";
import { WAVE_B_LIMITS } from "@/types/domain";
import { PRESENCE_ACTIONS, latestByActor, presenceWindowStart, toPresenceDTO } from "@/server/presence";

const NOW = new Date("2026-09-20T14:00:00.000Z");
const ref = (id: string) => ({ id, name: id.toUpperCase(), email: `${id}@wm-helpdesk.local`, image: null });

describe("presenceWindowStart", () => {
  it("uses the code-owned window, not a literal", () => {
    expect(presenceWindowStart(NOW).getTime()).toBe(NOW.getTime() - WAVE_B_LIMITS.presenceWindowMs);
  });

  it("accepts an explicit window for a caller that wants a tighter one", () => {
    expect(presenceWindowStart(NOW, 90_000).toISOString()).toBe("2026-09-20T13:58:30.000Z");
  });
});

describe("PRESENCE_ACTIONS", () => {
  it("counts a DETAIL view and never a dashboard preview", () => {
    expect([...PRESENCE_ACTIONS]).toEqual(["TICKET_VIEWED"]);
    expect([...PRESENCE_ACTIONS]).not.toContain("TICKET_PREVIEWED");
  });
});

describe("latestByActor", () => {
  it("keeps one row per person — their most recent", () => {
    const latest = latestByActor(
      [
        { actorId: "a", occurredAt: new Date("2026-09-20T13:59:00.000Z") },
        { actorId: "a", occurredAt: new Date("2026-09-20T13:57:00.000Z") },
        { actorId: "b", occurredAt: new Date("2026-09-20T13:58:00.000Z") },
      ],
      "me",
    );
    expect(latest.size).toBe(2);
    expect(latest.get("a")?.toISOString()).toBe("2026-09-20T13:59:00.000Z");
  });

  it("never reports the viewer back to themselves", () => {
    const latest = latestByActor([{ actorId: "me", occurredAt: NOW }], "me");
    expect(latest.size).toBe(0);
  });

  it("ignores machine and client-API rows, which carry no actor", () => {
    expect(latestByActor([{ actorId: null, occurredAt: NOW }], "me").size).toBe(0);
  });
});

describe("toPresenceDTO", () => {
  it("orders most recent first and stamps the instant it was generated", () => {
    const latest = new Map([
      ["a", new Date("2026-09-20T13:57:00.000Z")],
      ["b", new Date("2026-09-20T13:59:00.000Z")],
    ]);
    const dto = toPresenceDTO(latest, [ref("a"), ref("b")], NOW);
    expect(dto.viewers.map((v) => v.user.id)).toEqual(["b", "a"]);
    expect(dto.generatedAt).toBe(NOW.toISOString());
  });

  it("drops a sighting whose user row did not come back — an offboarded account is not 'here'", () => {
    const latest = new Map([["gone", NOW]]);
    expect(toPresenceDTO(latest, [], NOW).viewers).toEqual([]);
  });
});
