/**
 * A client's email address must not travel in a URL.
 *
 * `requesterEmail` is a first-class ticket-list predicate, so the ticket header's
 * "has this person written before?" link used to build `/dashboard?requesterEmail=<address>`. Cloud
 * Run records the path and query verbatim in `httpRequest.requestUrl`, and the browser keeps them in
 * history and session restore — a store with its own retention and access control and none of the
 * PII redaction, capability gating or hash-chained accountability the rest of the design applies to
 * that exact datum. It is the one identifier the desk otherwise treats carefully: it is the client
 * API's authorization subject, `changeRequesterEmail` audits every change to it, and `assertPiiLight`
 * refuses to let a bare `@` into a Slack line for the same reason.
 *
 * Fix: the header prefers `requesterExternalId`, an opaque Ops Portal person pointer that answers the same
 * question and means nothing outside the database. `requesterEmail` stays a predicate — a ticket with
 * no linked person has nothing else to filter on, and `/api/tickets/export` supports it — so the
 * residual exposure is closed operationally.
 *
 * the build record
 *
 * Lives under `src/server/` rather than beside `ticket-header.tsx`: it imports `@/server/validation` to
 * prove the predicate really parses, and G1 forbids any file under `src/components/**` — tests included —
 * from importing a non-`.actions` server module.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTicketListQuery } from "@/server/validation";
import { buildTicketFilterChips, requesterFilterLabel } from "@/components/dashboard/ticket-filter-chips";
import { ticketQueryToParams } from "@/components/dashboard/ticket-query-params";
import type { TicketListQuery } from "@/types/domain";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const header = readFileSync(path.join(ROOT, "src/components/ticket/ticket-header.tsx"), "utf8");

const BASE: TicketListQuery = { sort: "createdAt", dir: "desc", page: 1, pageSize: 25 };

describe("the ticket header filters by the opaque person pointer when it has one", () => {
  it("builds the link from requesterExternalId, falling back to the address only without one", () => {
    const href = /const requesterHref =[\s\S]*?: null;/.exec(header)?.[0] ?? "";
    expect(href, "requesterHref not found — the header was restructured").not.toBe("");
    // The opaque branch must be FIRST: an address is only ever the fallback.
    expect(href.indexOf("requesterExternalId")).toBeGreaterThan(-1);
    expect(href.indexOf("requesterExternalId")).toBeLessThan(href.indexOf("requesterEmail"));
    expect(href).toContain("URLSearchParams({ requesterExternalId: ticket.requesterExternalId })");
  });

  it("the link's tooltip names the person, not the address", () => {
    expect(header).toContain("title={`All tickets from ${ticket.requesterName}`}");
    expect(header, "the address is back in the link title").not.toContain(
      "title={`All tickets from ${ticket.requesterEmail}`}",
    );
  });
});

describe("requesterExternalId is a real predicate end to end", () => {
  it("parses from the URL with the same tolerant id shape assigneeId uses", () => {
    expect(parseTicketListQuery({ requesterExternalId: "ops_portal_person_01H9" }).requesterExternalId).toBe(
      "ops_portal_person_01H9",
    );
    // Not id-shaped → dropped, never refused: these come off a URL a person may have edited.
    for (const bad of ["has space", "with@at", "semi;colon", "", "x".repeat(65)]) {
      expect(parseTicketListQuery({ requesterExternalId: bad }).requesterExternalId).toBeUndefined();
    }
  });

  it("round-trips through the URL serializer", () => {
    const q: TicketListQuery = { ...BASE, requesterExternalId: "ops_portal_person_01H9" };
    const p = ticketQueryToParams(q, { includeQueueKey: true });
    expect(p.get("requesterExternalId")).toBe("ops_portal_person_01H9");
    expect(p.get("requesterEmail")).toBeNull();
    expect(parseTicketListQuery(p).requesterExternalId).toBe("ops_portal_person_01H9");
  });

  it("is the one filter whose value never reaches the URL as an address", () => {
    const p = ticketQueryToParams({ ...BASE, requesterExternalId: "ops_portal_person_01H9" }, { includeQueueKey: true });
    expect(p.toString()).not.toMatch(/@/);
  });
});

describe("the chip names the client, never the id and never the address", () => {
  const opts = { showQueue: true, assignees: [] } as const;

  it("prints the resolved name", () => {
    const chips = buildTicketFilterChips(
      { ...BASE, requesterExternalId: "ops_portal_person_01H9" },
      { ...opts, requesterName: "Dana Client" },
    );
    const chip = chips.find((c) => c.key === "requesterExternalId");
    expect(chip?.label).toBe("Requester Dana Client");
    expect(chip?.label).not.toContain("ops_portal_person_01H9");
  });

  it("falls back to neutral wording rather than printing the id", () => {
    const chips = buildTicketFilterChips({ ...BASE, requesterExternalId: "ops_portal_person_01H9" }, opts);
    const chip = chips.find((c) => c.key === "requesterExternalId");
    expect(chip?.label).toBe("Requester Selected client");
    expect(requesterFilterLabel(undefined)).toBe("Selected client");
    expect(requesterFilterLabel("   ")).toBe("Selected client");
  });

  it("removing the chip drops only that key", () => {
    const q: TicketListQuery = { ...BASE, requesterExternalId: "ops_portal_person_01H9", search: "wire" };
    const chip = buildTicketFilterChips(q, opts).find((c) => c.key === "requesterExternalId");
    expect(chip?.next.requesterExternalId).toBeUndefined();
    expect(chip?.next.search).toBe("wire");
  });
});
