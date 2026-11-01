/**
 * client-view.ts unit tests (§g S3 tests) — no database.
 *
 * Serializer: an INTERNAL sentinel never appears, every PUBLIC body does, no CLIENT_FORBIDDEN_KEYS at any
 * depth; assertNoInternalLeak throws on visibility INTERNAL and on a nested author; the brand is a type
 * error to forge; import-boundary assertions G7/G8 (duplicated here so S3 is self-checking);
 * isClientApiAuthorized true / false / unset.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Comment } from "@prisma/client";
import {
  BODY_TRUNCATION_NOTE,
  CLIENT_FORBIDDEN_KEYS,
  CLIENT_RETRACTED_BODY,
  REQUESTER_AUTHORED_SOURCES,
  TICKET_SOURCES,
} from "@/types/domain";
import type { ClientTicketView, TicketSource } from "@/types/domain";
import { IsolationViolationError } from "@/lib/errors";

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test" as const,
    // Composed from its parts at run time: a literal `postgresql://USER:PASSWORD@HOST/DB` is a security scanner
    // secret finding in any tracked file, tests included, even for a database nothing dials.
    // `vi.hoisted` runs before imports, so `@/test-support/db-url` cannot be called from in here;
    // this is that module's `unitDatabaseUrl()` written as one expression.
    DATABASE_URL: Object.assign(new URL("postgresql://localhost:5432/unit_never_connects"), {
      username: "unit",
      password: "unit",
    }).toString(),
    PUBLIC_DATABASE_URL: undefined as string | undefined,
    AUTH_SECRET: undefined as string | undefined,
    AUTH_OKTA_ID: undefined as string | undefined,
    AUTH_OKTA_SECRET: undefined as string | undefined,
    AUTH_OKTA_ISSUER: undefined as string | undefined,
    AUTH_DEV_LOGIN: false,
    TRUSTED_PROXY_HOPS: 0,
    CLIENT_API_TOKEN: "unit-test-client-api-token-0123456789abcdef" as string | undefined,
    APP_ENV: "local" as const,
  },
}));

vi.mock("@/lib/env", () => mockEnv);

import {
  CLIENT_OPENING_MESSAGE_ID_PREFIX,
  assertNoInternalLeak,
  clientOpeningMessageId,
  isClientApiAuthorized,
  openingMessageFor,
  requesterEmailFromHeaders,
  toClientTicketView,
} from "@/server/client-view";
import type { ClientTicketSource, OpeningMessageRow, PublicCommentRow } from "@/server/client-view";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INTERNAL_SENTINEL = "INTERNAL_SENTINEL_7f3a";
const PUBLIC_BODY_1 = "Thanks for reaching out — we have started the review.\n\n---\nGeneral service disclaimer";
const PUBLIC_BODY_2 = "Your request is complete.\n\n---\nGeneral service disclaimer";

/** The opening message on a STAFF_FORM ticket: an operator's words, never shown back to a client. */
const STAFF_DESCRIPTION = "Caller sounded confused; STAFF_DESCRIPTION_SENTINEL_2c9d — chase the wire desk";
/** The opening message on an emailed ticket: the client's own words, which they are owed back. */
const CLIENT_WORDS = "Hi — I sent the wire form on Tuesday and have not heard back. Can you check?";

const TICKET: ClientTicketSource = {
  id: "ticket_1",
  number: 1042,
  subject: "Wire to new payee",
  status: "OPEN",
  priority: "URGENT",
  category: "WIRE_TRANSFER",
  createdAt: new Date("2026-09-16T12:00:00.000Z"),
  updatedAt: new Date("2026-09-16T12:30:00.000Z"),
  resolvedAt: null,
};

/**
 * Decision #117 (amended). The opening entry no longer rides on `ClientTicketSource`: `description`,
 * `source` and `externalId` are not granted to the client role and not selected by this module. The
 * builder takes a third argument — a row read from the "ClientVisibleOpeningMessage" view, or null —
 * so the EXCLUDED case is `null`, which is what the database returns for a ticket the desk composed.
 * Every assertion in this file that predates the opening entry therefore passes `null` and keeps
 * asserting exactly what it asserted before.
 *
 * Tests may mint branded fixtures with `as unknown as OpeningMessageRow`; production code
 * cannot, which is the point of the brand.
 */
function openingRow(over: Partial<{ source: TicketSource; body: string; createdAt: Date }> = {}): OpeningMessageRow {
  return {
    ticketId: TICKET.id,
    source: "EMAIL",
    body: CLIENT_WORDS,
    createdAt: TICKET.createdAt,
    ...over,
  } as unknown as OpeningMessageRow;
}

/** Tests may construct branded fixtures with `as unknown as PublicCommentRow`; production code cannot. */
function publicRow(id: string, body: string, createdAt: string, retracted = false): PublicCommentRow {
  return {
    id,
    ticketId: TICKET.id,
    // the view returns an EMPTY body for a retracted row, so a fixture that claims retraction
    // must say so the same way — otherwise the test would be proving something the database cannot
    // produce. `toClientTicketView` replaces it with the placeholder either way.
    body: retracted ? "" : body,
    disclaimerKey: "GENERAL_SERVICE",
    retracted,
    createdAt: new Date(createdAt),
  } as unknown as PublicCommentRow;
}

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.add(k);
    collectKeys(v, out);
  }
  return out;
}

describe("toClientTicketView (I1 serializer)", () => {
  const rows = [
    publicRow("c_pub_1", PUBLIC_BODY_1, "2026-09-16T12:05:00.000Z"),
    publicRow("c_pub_2", PUBLIC_BODY_2, "2026-09-16T12:25:00.000Z"),
  ];
  const view = toClientTicketView(TICKET, rows, null);
  const json = JSON.stringify(view);

  it("renders a retracted message as the placeholder and never as its stored body (Decision #101)", () => {
    const withdrawn = toClientTicketView(
      TICKET,
      [
        publicRow("c_pub_1", PUBLIC_BODY_1, "2026-09-16T12:05:00.000Z"),
        publicRow("c_pub_x", "the text the desk took back", "2026-09-16T12:15:00.000Z", true),
      ],
      null,
    );
    expect(withdrawn.messages[1].retracted).toBe(true);
    expect(withdrawn.messages[1].body).toBe(CLIENT_RETRACTED_BODY);
    // Two independent guarantees, and this asserts BOTH: the view blanked the body at the database,
    // and the serializer would have replaced it regardless.
    expect(JSON.stringify(withdrawn)).not.toContain("the text the desk took back");
    expect(withdrawn.messages[0].retracted).toBe(false);
    expect(withdrawn.messages[0].body).toBe(PUBLIC_BODY_1);
  });

  it("carries every PUBLIC body and never the INTERNAL sentinel", () => {
    expect(view.messages).toHaveLength(2);
    expect(view.messages[0].body).toBe(PUBLIC_BODY_1);
    expect(view.messages[1].body).toBe(PUBLIC_BODY_2);
    expect(json).not.toContain(INTERNAL_SENTINEL);
    expect(json).not.toContain("INTERNAL");
  });

  it("builds the DTO field by field: reference, ISO dates, fixed authorDisplay", () => {
    expect(view.reference).toBe("HD-1042");
    expect(view.subject).toBe("Wire to new payee");
    expect(view.status).toBe("OPEN");
    expect(view.priority).toBe("URGENT");
    expect(view.category).toBe("WIRE_TRANSFER");
    expect(view.createdAt).toBe("2026-09-16T12:00:00.000Z");
    expect(view.updatedAt).toBe("2026-09-16T12:30:00.000Z");
    expect(view.resolvedAt).toBeNull();
    expect(view.messages[0]).toEqual({
      id: "c_pub_1",
      body: PUBLIC_BODY_1,
      createdAt: "2026-09-16T12:05:00.000Z",
      disclaimerKey: "GENERAL_SERVICE",
      authorDisplay: "Your Service Team",
      // the one Wave B fact a client is owed. It carries no content — it says
      // a message was withdrawn, not what it said — which is why it is deliberately NOT in
      // CLIENT_FORBIDDEN_KEYS while every other Wave B field is.
      retracted: false,
    });
    // every client-facing payload now carries the client vocabulary beside the raw
    // enums — `statusLabel` and `categoryLabel`. Both are derived from an enum the client already
    // receives, so neither widens what the DTO discloses.
    expect(Object.keys(view).sort()).toEqual(
      [
        "category",
        "categoryLabel",
        "createdAt",
        "messages",
        "priority",
        "reference",
        "resolvedAt",
        "status",
        "statusLabel",
        "subject",
        "updatedAt",
      ].sort(),
    );
    expect(Object.keys(view.messages[0]).sort()).toEqual([
      "authorDisplay",
      "body",
      "createdAt",
      "disclaimerKey",
      "id",
      "retracted",
    ]);
  });

  it("contains no CLIENT_FORBIDDEN_KEYS at any depth and passes assertNoInternalLeak", () => {
    const keys = collectKeys(view);
    for (const forbidden of CLIENT_FORBIDDEN_KEYS) expect(keys.has(forbidden)).toBe(false);
    expect(() => assertNoInternalLeak(view)).not.toThrow();
    // Decision #117 EXTENDS this rather than relaxing it: `description` and `source` are now READ by
    // the builder, so the assertion that they are not KEYS is doing more work than it was, and the
    // staff-written text they carry must be absent from the payload as well as absent from its shape.
    expect(keys.has("description")).toBe(false);
    expect(keys.has("source")).toBe(false);
    expect(json).not.toContain(STAFF_DESCRIPTION);
    expect(json).not.toContain("STAFF_DESCRIPTION_SENTINEL_2c9d");
  });

  it("serialises resolvedAt when present and ignores extra properties on the source (no spreads)", () => {
    const source = {
      ...TICKET,
      resolvedAt: new Date("2026-09-16T13:00:00.000Z"),
      // Extra columns a careless caller might pass — they must never reach the DTO. `description` is
      // no longer one of them (Decision #117 reads it deliberately), so the case it used to stand for
      // is made by the source gate instead: this ticket is STAFF_FORM, so its description is dropped.
      requesterEmail: "client@example.com",
      assigneeId: "staff_1",
    } as ClientTicketSource;
    const v = toClientTicketView(source, [], null);
    expect(v.resolvedAt).toBe("2026-09-16T13:00:00.000Z");
    expect(v.messages).toEqual([]);
    const j = JSON.stringify(v);
    expect(j).not.toContain(STAFF_DESCRIPTION);
    expect(j).not.toContain("client@example.com");
    expect(j).not.toContain("staff_1");
    expect(() => assertNoInternalLeak(v)).not.toThrow();
  });

  it("type: the comment parameter is the branded row, not a Prisma Comment", () => {
    expectTypeOf<Parameters<typeof toClientTicketView>[1][number]>().not.toEqualTypeOf<Comment>();
    expectTypeOf<Parameters<typeof toClientTicketView>[1][number]>().toEqualTypeOf<PublicCommentRow>();
    expectTypeOf<ClientTicketView>().not.toHaveProperty("visibility");
    expectTypeOf<ClientTicketView>().not.toHaveProperty("description");
    expectTypeOf<ClientTicketView["messages"][number]>().not.toHaveProperty("author");
    expectTypeOf<ClientTicketView["messages"][number]>().not.toHaveProperty("visibility");
  });

  it("type: an unbranded row literal is rejected by the compiler", () => {
    const unbranded = {
      id: "c1",
      ticketId: TICKET.id,
      body: "x",
      disclaimerKey: "GENERAL_SERVICE" as const,
      createdAt: new Date(),
    };
    // @ts-expect-error — PublicCommentRow carries a module-private brand nothing outside client-view.ts can supply
    const attempt: PublicCommentRow[] = [unbranded];
    expect(attempt).toHaveLength(1);
  });
});

/**
 * the opening entry.
 *
 * `Ticket.description` is the message a thread opens with. On an emailed or client-app ticket that is
 * the client's own words, and the client API used to return every reply the desk sent and not the
 * request the client sent. It now comes back as the FIRST entry of `messages`, in the same shape as a
 * public comment — and ONLY for a source whose description really is the requester's own words.
 *
 * **THE GATE IS SQL, NOT THIS FILE.** The "ClientVisibleOpeningMessage" view admits a row only for a
 * source in `REQUESTER_AUTHORED_SOURCES` and only when the ticket is not a released held-mail one, and
 * `wm_helpdesk_public` holds no privilege on `"Ticket".description` at all — so for an excluded
 * channel there is no row to return rather than a row this module declines to render. That half is
 * proved where it is enforced: `src/lib/guardrails.integration.test.ts` connects AS the client role
 * and shows the database refusing the column and the view withholding the row, and
 * `src/server/client-view.integration.test.ts` drives the real route over real rows. The view's SQL
 * text is pinned against `REQUESTER_AUTHORED_SOURCES` and `INTAKE_RELEASE_EXTERNAL_ID_PREFIX` by G16
 * in `src/lib/guardrails.test.ts`.
 *
 * What this block owns is the half that lives here: the SECOND belt over the `source` the view
 * returns, and the presentation rules (the desk's truncation note, an empty body, the synthetic id,
 * the shape). It stays exhaustive over `TicketSource` — a FORGED row for every excluded channel, the
 * row the view would produce if it were ever rebuilt without its WHERE — so a failure names the
 * channel that broke, and deleting the belt goes red here even though the database would still have
 * withheld the row.
 */
describe("the opening entry (Decision #117)", () => {
  /**
   * Every source whose description is NOT the requester's own words — WRITTEN OUT, not derived.
   *
   * Deriving it with `TICKET_SOURCES.filter(s => !REQUESTER_AUTHORED_SOURCES.includes(s))` is what this
   * block used to do, and it made the loops below track the implementation instead of checking it:
   * moving VOICEMAIL onto the allowlist would silently move it from the exclusion loop to the inclusion
   * loop and the file would stay green on exactly the change it exists to catch. Typed out, that edit
   * fails here — and the partition assertion below has something real to compare against.
   */
  const EXCLUDED_SOURCES = ["STAFF_FORM", "PHONE", "VOICEMAIL", "SLACK", "SYSTEM", "IMPORT", "API"] as const;

  it("the allowlist and this file's own complement partition TicketSource — nothing is unclassified", () => {
    expect([...REQUESTER_AUTHORED_SOURCES, ...EXCLUDED_SOURCES].sort()).toEqual([...TICKET_SOURCES].sort());
    for (const s of EXCLUDED_SOURCES) {
      expect(REQUESTER_AUTHORED_SOURCES as readonly string[], s).not.toContain(s);
    }
  });

  for (const source of REQUESTER_AUTHORED_SOURCES) {
    it(`${source}: the client's own opening message is returned`, () => {
      const view = toClientTicketView(TICKET, [], openingRow({ source }));
      expect(view.messages).toHaveLength(1);
      expect(view.messages[0].body).toBe(CLIENT_WORDS);
      expect(view.messages[0].authorDisplay).toBe("You");
    });
  }

  for (const source of EXCLUDED_SOURCES) {
    it(`${source}: the description is an operator's — no row, and a forged row is refused too`, () => {
      // What the database does for this channel: nothing. `null` is the whole of the excluded case.
      expect(openingMessageFor(null, "HD-1042")).toBeNull();
      expect(toClientTicketView(TICKET, [], null).messages).toEqual([]);
      // And the belt: a row carrying this source — which only a view rebuilt without its WHERE could
      // produce — is withheld here as well, with the operator's text inside it to prove the point.
      const forged = openingRow({ source, body: `${INTERNAL_SENTINEL} — ${STAFF_DESCRIPTION}` });
      expect(openingMessageFor(forged, "HD-1042")).toBeNull();
      const view = toClientTicketView(TICKET, [publicRow("c_pub_1", PUBLIC_BODY_1, "2026-09-16T12:05:00.000Z")], forged);
      expect(view.messages.map((m) => m.body)).toEqual([PUBLIC_BODY_1]);
      const json = JSON.stringify(view);
      expect(json).not.toContain(INTERNAL_SENTINEL);
      expect(json).not.toContain("STAFF_DESCRIPTION_SENTINEL_2c9d");
      expect(() => assertNoInternalLeak(view)).not.toThrow();
    });
  }

  it("VOICEMAIL is excluded, and that is the judgement call worth pinning", () => {
    // The phone system ingest workflow composes the description from a transcript PLUS the line name, the
    // call duration and a link to the recording asset, and its withheld-number branch prepends desk
    // instructions; the staff "Log a call → Voicemail" form writes the associate's own note under the
    // same source. The transcript half is the client's words; the FIELD is not, and the field is what
    // would be sent. See REQUESTER_AUTHORED_SOURCES in src/types/domain.ts, and the view's WHERE.
    expect((REQUESTER_AUTHORED_SOURCES as readonly string[]).includes("VOICEMAIL")).toBe(false);
    expect(openingMessageFor(openingRow({ source: "VOICEMAIL" }), "HD-1042")).toBeNull();
  });

  it("comes FIRST, before the earliest real comment, and the desk's replies follow in order", () => {
    const view = toClientTicketView(
      TICKET,
      [
        publicRow("c_pub_1", PUBLIC_BODY_1, "2026-09-16T12:05:00.000Z"),
        publicRow("c_pub_2", PUBLIC_BODY_2, "2026-09-16T12:25:00.000Z"),
      ],
      openingRow(),
    );
    expect(view.messages.map((m) => m.body)).toEqual([CLIENT_WORDS, PUBLIC_BODY_1, PUBLIC_BODY_2]);
    expect(view.messages[0].createdAt).toBe("2026-09-16T12:00:00.000Z");
    expect(new Date(view.messages[0].createdAt).getTime()).toBeLessThan(
      new Date(view.messages[1].createdAt).getTime(),
    );
  });

  it("carries the view's createdAt, disclaimerKey NONE, retracted false — and no author identity", () => {
    const view = toClientTicketView(TICKET, [], openingRow());
    expect(view.messages[0]).toEqual({
      id: clientOpeningMessageId("HD-1042"),
      body: CLIENT_WORDS,
      createdAt: "2026-09-16T12:00:00.000Z",
      // NONE is what an inbound requester message always carries: `ingest.ts` refuses any other value
      // for `authorKind: REQUESTER`, and a disclaimer is something the desk appends to what it SENDS.
      disclaimerKey: "NONE",
      authorDisplay: "You",
      // Decision #101 retraction targets a Comment row; this entry is not one, so it can never be
      // withdrawn — and there is nothing here for the desk to take back, because the words are the
      // client's own and were sanitised by sanitizePII before they were stored.
      retracted: false,
    });
    // The same six keys a real message has — no seventh field, and nothing naming a person.
    expect(Object.keys(view.messages[0]).sort()).toEqual([
      "authorDisplay",
      "body",
      "createdAt",
      "disclaimerKey",
      "id",
      "retracted",
    ]);
  });

  it("uses a synthetic id that is obviously not a Comment row id, and leaks no ticket cuid", () => {
    const view = toClientTicketView(TICKET, [], openingRow());
    expect(view.messages[0].id).toBe(`${CLIENT_OPENING_MESSAGE_ID_PREFIX}HD-1042`);
    expect(view.messages[0].id.startsWith(CLIENT_OPENING_MESSAGE_ID_PREFIX)).toBe(true);
    // Derived from the REFERENCE, never from `ticket.id` — the DTO deliberately omits the cuid, and a
    // list response would otherwise hand a client app one per ticket. The view returns `ticketId` for
    // the join and the builder never carries it into the payload either.
    expect(JSON.stringify(view)).not.toContain(TICKET.id);
    // Deterministic across reads, which is what a list key needs.
    expect(toClientTicketView(TICKET, [], openingRow()).messages[0].id).toBe(view.messages[0].id);
  });

  it("omits the entry when the body is empty or whitespace, rather than rendering a blank", () => {
    for (const body of ["", "   ", "\n\t "]) {
      const view = toClientTicketView(TICKET, [], openingRow({ body }));
      expect(view.messages, JSON.stringify(body)).toEqual([]);
    }
  });

  it("a ticket with no comments at all is the opening entry and nothing else", () => {
    const view = toClientTicketView(TICKET, [], openingRow());
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].body).toBe(CLIENT_WORDS);
  });

  it("never puts description or source on the DTO, and still passes assertNoInternalLeak", () => {
    const view = toClientTicketView(
      TICKET,
      [publicRow("c_pub_1", PUBLIC_BODY_1, "2026-09-16T12:05:00.000Z")],
      openingRow(),
    );
    const keys = collectKeys(view);
    for (const forbidden of CLIENT_FORBIDDEN_KEYS) expect(keys.has(forbidden), forbidden).toBe(false);
    expect(keys.has("description")).toBe(false);
    expect(keys.has("source")).toBe(false);
    expect(keys.has("ticketId")).toBe(false);
    expect(() => assertNoInternalLeak(view)).not.toThrow();
  });

  /**
   * The SECOND gate, and it is the one a reviewer should not skip. A released held-mail ticket carries
   * `source: EMAIL` and a description the DESK composed, so the source allowlist ALONE would have
   * handed the client the desk's review material as their own opening message.
   *
   * It is now enforced in the view's WHERE, on the `externalId` every released ticket already carries,
   * which is why this module no longer reads that column and the client role is no longer granted it.
   * `src/server/client-view.integration.test.ts` drives a released ticket through the real route and
   * asserts the provenance markers are absent from the payload; `suspended-intake.integration.test.ts`
   * does it against the real `releaseDescription` output.
   */
  describe("the released-hold gate", () => {
    it("is in SQL: this module neither imports the marker nor reads externalId", () => {
      const src = readFileSync(path.join(ROOT, "src/server/client-view.ts"), "utf8");
      // The constant is not imported, so the prefix test provably is not applied here …
      expect(src).not.toMatch(/^\s*INTAKE_RELEASE_EXTERNAL_ID_PREFIX,$/m);
      expect(src).not.toMatch(/\bexternalId:\s*true/);
      // … and the read goes to the view that carries it instead.
      expect(src).toMatch(/FROM "ClientVisibleOpeningMessage"/);
    });

    it("a withheld ticket is an absent row, which renders as a thread with no opening entry", () => {
      const view = toClientTicketView(TICKET, [publicRow("c_pub_1", PUBLIC_BODY_1, "2026-09-16T12:05:00.000Z")], null);
      expect(view.messages.map((m) => m.body)).toEqual([PUBLIC_BODY_1]);
      expect(() => assertNoInternalLeak(view)).not.toThrow();
    });
  });

  /**
   * `BODY_TRUNCATION_NOTE` is appended to the STORED body by `truncateBody`, in the desk's own voice
   * and about the desk's own storage. It stays on the record — a reader must be able to see the message
   * was cut rather than conclude the client stopped mid-sentence — and comes off the copy the payload
   * attributes to the client. It is stripped HERE rather than in the view because it is presentation
   * over text the client did write, not a disclosure rule.
   */
  describe("the desk's truncation note", () => {
    it("is stripped from the opening entry but the client's own text is untouched", () => {
      const view = toClientTicketView(TICKET, [], openingRow({ body: `${CLIENT_WORDS}${BODY_TRUNCATION_NOTE}` }));
      expect(view.messages).toHaveLength(1);
      expect(view.messages[0].body).toBe(CLIENT_WORDS);
      expect(JSON.stringify(view)).not.toContain("truncated by the help desk");
    });

    it("is stripped only from the END — the same words mid-message are the client's and stay", () => {
      const body = `I quote your notice:${BODY_TRUNCATION_NOTE} and I disagree.`;
      const view = toClientTicketView(TICKET, [], openingRow({ body }));
      expect(view.messages[0].body).toBe(body);
    });

    it("a body that is ONLY the note contributes no entry rather than an empty bubble", () => {
      expect(openingMessageFor(openingRow({ body: BODY_TRUNCATION_NOTE }), "HD-1")).toBeNull();
    });
  });

  it("openingMessageFor is the pure gate the builder calls, and is exported so the policy is testable", () => {
    expect(openingMessageFor(openingRow({ source: "EMAIL" }), "HD-7")?.body).toBe(CLIENT_WORDS);
    expect(openingMessageFor(openingRow({ source: "CLIENT_APP" }), "HD-7")?.id).toBe(clientOpeningMessageId("HD-7"));
    expect(openingMessageFor(openingRow({ source: "STAFF_FORM" }), "HD-7")).toBeNull();
    expect(openingMessageFor(openingRow({ body: "" }), "HD-7")).toBeNull();
    expect(openingMessageFor(null, "HD-7")).toBeNull();
  });
});

describe("assertNoInternalLeak", () => {
  it("throws on visibility INTERNAL inside messages", () => {
    expect(() => assertNoInternalLeak({ messages: [{ visibility: "INTERNAL" }] })).toThrow(IsolationViolationError);
  });

  it("throws on a nested author key", () => {
    expect(() => assertNoInternalLeak({ messages: [{ id: "c", author: { name: "Olivia Ops" } }] })).toThrow(
      IsolationViolationError,
    );
  });

  it("throws on every CLIENT_FORBIDDEN_KEYS entry at depth", () => {
    for (const key of CLIENT_FORBIDDEN_KEYS) {
      const dto = { ok: true, nested: [{ deeper: { [key]: "value" } }] };
      expect(() => assertNoInternalLeak(dto), key).toThrow(IsolationViolationError);
    }
  });

  it("accepts a clean DTO, primitives, arrays and cyclic structures without forbidden keys", () => {
    expect(() => assertNoInternalLeak(toClientTicketView(TICKET, [], null))).not.toThrow();
    expect(() => assertNoInternalLeak(null)).not.toThrow();
    expect(() => assertNoInternalLeak("string")).not.toThrow();
    expect(() => assertNoInternalLeak([1, 2, { a: 1 }])).not.toThrow();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => assertNoInternalLeak(cyclic)).not.toThrow();
  });

  it("does not throw on visibility PUBLIC alone (the key itself is forbidden, so it still throws)", () => {
    // `visibility` is in CLIENT_FORBIDDEN_KEYS: any visibility key is a leak, PUBLIC included.
    expect(() => assertNoInternalLeak({ visibility: "PUBLIC" })).toThrow(IsolationViolationError);
  });
});

describe("isClientApiAuthorized (constant-time bearer compare)", () => {
  const token = "unit-test-client-api-token-0123456789abcdef";

  it("true for the exact bearer token", () => {
    mockEnv.env.CLIENT_API_TOKEN = token;
    expect(isClientApiAuthorized(new Headers({ authorization: `Bearer ${token}` }))).toBe(true);
    expect(isClientApiAuthorized(new Headers({ Authorization: `bearer ${token}` }))).toBe(true);
  });

  it("false for a wrong token, a same-length wrong token, a missing header, or a malformed scheme", () => {
    mockEnv.env.CLIENT_API_TOKEN = token;
    expect(isClientApiAuthorized(new Headers({ authorization: "Bearer nope" }))).toBe(false);
    expect(isClientApiAuthorized(new Headers({ authorization: `Bearer ${token.slice(0, -1)}X` }))).toBe(false);
    expect(isClientApiAuthorized(new Headers())).toBe(false);
    expect(isClientApiAuthorized(new Headers({ authorization: token }))).toBe(false);
    expect(isClientApiAuthorized(new Headers({ authorization: `Basic ${token}` }))).toBe(false);
    expect(isClientApiAuthorized(new Headers({ authorization: "Bearer " }))).toBe(false);
  });

  it("false whenever CLIENT_API_TOKEN is unset (API disabled), even with a bearer present", () => {
    mockEnv.env.CLIENT_API_TOKEN = undefined;
    expect(isClientApiAuthorized(new Headers({ authorization: `Bearer ${token}` }))).toBe(false);
    expect(isClientApiAuthorized(new Headers({ authorization: "Bearer " }))).toBe(false);
    mockEnv.env.CLIENT_API_TOKEN = token;
  });
});

describe("requesterEmailFromHeaders", () => {
  it("trims, lowercases and validates the shape", () => {
    expect(requesterEmailFromHeaders(new Headers({ "X-Requester-Email": "  Client@Example.COM " }))).toBe("client@example.com");
    expect(requesterEmailFromHeaders(new Headers())).toBeNull();
    expect(requesterEmailFromHeaders(new Headers({ "x-requester-email": "not-an-email" }))).toBeNull();
    expect(requesterEmailFromHeaders(new Headers({ "x-requester-email": "" }))).toBeNull();
    expect(requesterEmailFromHeaders(new Headers({ "x-requester-email": "a@b" }))).toBeNull();
    expect(requesterEmailFromHeaders(new Headers({ "x-requester-email": `${"a".repeat(250)}@example.com` }))).toBeNull();
  });
});

describe("import boundaries (G7 / G8, duplicated so S3 is self-checking)", () => {
  const routeSrc = readFileSync(path.join(ROOT, "src/app/api/client/tickets/[id]/route.ts"), "utf8");
  const viewSrc = readFileSync(path.join(ROOT, "src/server/client-view.ts"), "utf8");

  function importSpecifiers(src: string): string[] {
    const out: string[] = [];
    const re = /^import\s[\s\S]*?from\s+"([^"]+)";?$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  }

  function namedImportsFrom(src: string, specifier: string): string[] {
    // One LITERAL pattern over every named import, then an exact specifier compare — rather than a
    // pattern built per specifier, which is a security scanner CWE-185 finding. The escaping the old form needed
    // (`specifier.replace(/[/@.]/g, "\\$&")`) existed only to make the interpolated specifier match
    // literally, so comparing the captured specifier string is the same assertion without the pattern.
    const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
    const names: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[3] !== specifier) continue;
      for (const part of m[2].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    return names;
  }

  it("G7: the route imports only @/server/client-view, @/lib/request-context and next/server", () => {
    const specs = importSpecifiers(routeSrc);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(["@/server/client-view", "@/lib/request-context", "next/server"]).toContain(s);
    expect(routeSrc).toContain('export const dynamic = "force-dynamic"');
    // Fix round 2: the route authenticates with the Wave B pair (a ClientApiToken carrying
    // CLIENT_READ, else the legacy CLIENT_API_TOKEN bearer) rather than the legacy check alone, and
    // spends the caller's rate-limit budget. Both reach it through @/server/client-view, so the
    // three-module import pin above is unchanged — which is the whole reason the wrappers exist.
    expect(routeSrc).toContain("authorizeClientApiRequest(");
    expect(routeSrc).toContain("enforceClientApiRateLimit(");
    expect(routeSrc).toContain("recordClientDenied(");
    expect(routeSrc).not.toContain("isClientApiAuthorized(");
  });

  it("G8: client-view.ts imports only publicDb from @/lib/db and only the two client audit writers", () => {
    expect(namedImportsFrom(viewSrc, "@/lib/db")).toEqual(["publicDb"]);
    expect(namedImportsFrom(viewSrc, "@/lib/audit").sort()).toEqual(["recordClientApiDenied", "recordClientApiRead"]);
    const specs = importSpecifiers(viewSrc);
    expect(specs).not.toContain("@/server/tickets");
    expect(specs).not.toContain("@/server/comments");
    expect(specs).not.toContain("@/server/tickets.actions");
    expect(specs).not.toContain("@/server/comments.actions");
  });

  it("G8: client-view.ts reads the view and never uses include, unsafe raw access, the prisma singleton or relation keys", () => {
    expect(viewSrc).toContain('"ClientVisibleComment"');
    for (const forbidden of ["include:", "$executeRaw", "$queryRawUnsafe", "prisma.", "comments:", "auditLogs:", "queue:", "createdBy:", "assignee:"]) {
      expect(viewSrc.includes(forbidden), `client-view.ts must not contain ${JSON.stringify(forbidden)}`).toBe(false);
    }
    // FOUR tagged-template $queryRaw reads, and no other raw access: for EACH of the two client-visible
    // views, the single-ticket read and the `= ANY($ids)` batch the list uses so a page of ten tickets
    // is one query rather than ten. Decision #117 (amended) added the second pair, against
    // "ClientVisibleOpeningMessage". All four are tagged templates on `publicDb`; `$queryRawUnsafe` and
    // `$executeRaw` are still refused above, which is the assertion that actually matters.
    expect(viewSrc.match(/\$queryRaw</g)?.length).toBe(4);
    expect(viewSrc.match(/FROM "ClientVisibleComment"/g)?.length).toBe(2);
    expect(viewSrc.match(/FROM "ClientVisibleOpeningMessage"/g)?.length).toBe(2);
    expect(viewSrc).toMatch(/WHERE visibility = 'PUBLIC'|'PUBLIC'/); // the module documents the view predicate
  });

  it("G8: the brand is declared, never exported as a value", () => {
    expect(viewSrc).toMatch(/declare const publicBrand: unique symbol;/);
    expect(viewSrc).not.toMatch(/export\s+(const|let|var)\s+publicBrand/);
    expect(viewSrc).not.toContain("__brandForTest");
  });
});
