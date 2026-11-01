/**
 * Unit tests for the webhook server module's pure surface.
 *
 * Two things are being pinned here and they are both controls rather than behaviour:
 *
 *  - the payload carries no client material, including in the cases where an audit row's `oldValue` /
 *    `newValue` DOES carry it (a reply body, a subject, an assignee id);
 *  - the SSRF guard's DNS half refuses on a resolver failure and on a mixed answer, not only on an
 *    obviously-private one.
 */
import { describe, expect, it } from "vitest";
import type { AuditAction } from "@/types/domain";
import { AUDIT_ACTIONS } from "@/types/domain";
import { assertPublicHttpsUrl } from "@/lib/ssrf-guard";
import {
  WEBHOOK_ENUM_VALUED_ACTIONS,
  WEBHOOK_SUBSCRIBABLE_ACTIONS,
  WebhookPayloadPiiError,
  assertEndpointUrlAllowed,
  assertPayloadPiiLight,
  buildWebhookPayload,
  carriesEnumValues,
  createWebhookEndpointSchema,
  isSubscribableAction,
  revokeWebhookEndpointSchema,
  serializeWebhookPayload,
  subscribableActionsInCatalogOrder,
  ticketDeepLink,
  toWebhookDeliveryDTO,
  toWebhookEndpointDTO,
  updateWebhookEndpointSchema,
} from "@/server/webhooks";
import type { WebhookSourceEvent, WebhookTicketFacts } from "@/server/webhooks";
import { groupedEventActions } from "@/components/admin/webhooks/webhook-form-support";

const TICKET: WebhookTicketFacts = {
  id: "ckticket000001",
  number: 1482,
  queue: "OPERATIONS",
  status: "RESOLVED",
  priority: "URGENT",
  category: "WIRE_TRANSFER",
  brand: "CEDAR_RIDGE_WEALTH",
  createdAt: "2026-09-18T12:00:00.000Z",
  updatedAt: "2026-09-20T09:30:00.000Z",
};

function event(overrides: Partial<WebhookSourceEvent> = {}): WebhookSourceEvent {
  return {
    seq: BigInt(4211),
    action: "TICKET_STATUS_CHANGED",
    entityType: "TICKET",
    entityId: TICKET.id,
    fieldChanged: "status",
    oldValue: "OPEN",
    newValue: "RESOLVED",
    occurredAt: new Date("2026-09-20T09:30:00.000Z"),
    ticket: TICKET,
    ...overrides,
  };
}

describe("the subscribable allowlist", () => {
  it("names only real audit actions", () => {
    for (const action of WEBHOOK_SUBSCRIBABLE_ACTIONS) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });

  it("excludes every read, every authorization row and every administrative row", () => {
    const forbidden: AuditAction[] = [
      "TICKET_VIEWED",
      "TICKET_PREVIEWED",
      "CLIENT_API_READ",
      "ATTACHMENT_VIEWED",
      "TICKET_EXPORT_READ",
      "AUDIT_LOG_VIEWED",
      "AUDIT_LOG_EXPORTED",
      "AUTHZ_DENIED",
      "AUTHZ_DENIED_COALESCED",
      "USER_SIGNED_IN",
      "USER_SIGNED_OUT",
      "API_TOKEN_CREATED",
      "API_TOKEN_REVOKED",
      "API_TOKEN_ROTATED",
      "WEBHOOK_ENDPOINT_CREATED",
      "WEBHOOK_DELIVERY_SENT",
      "PUSH_SUBSCRIBED",
      "MACRO_UPDATED",
      "SUPPRESSION_ADDED",
      "JOB_RUN",
    ];
    for (const action of forbidden) {
      expect(isSubscribableAction(action), action).toBe(false);
    }
  });

  it("excludes COMMENT_ADDED_INTERNAL — an internal note never leaves the desk (I1)", () => {
    expect(isSubscribableAction("COMMENT_ADDED_INTERNAL")).toBe(false);
  });

  it("has no duplicates and reports catalog order", () => {
    expect(new Set(WEBHOOK_SUBSCRIBABLE_ACTIONS).size).toBe(WEBHOOK_SUBSCRIBABLE_ACTIONS.length);
    const ordered = subscribableActionsInCatalogOrder();
    expect(new Set(ordered)).toEqual(new Set(WEBHOOK_SUBSCRIBABLE_ACTIONS));
    const indices = ordered.map((a) => AUDIT_ACTIONS.indexOf(a));
    expect([...indices].sort((x, y) => x - y)).toEqual(indices);
  });

  /**
   * The parity check lives HERE rather than beside the picker it is about, because G1 forbids anything
   * under `src/components/**` from value-importing a non-`.actions` server module — a test file
   * included. Without this assertion an event added to the allowlist and forgotten in the groups would
   * be subscribable by the API and invisible in the only UI anyone uses, and an event removed from the
   * allowlist but left in the picker would be offered and then rejected on save.
   */
  it("is exactly what the admin picker offers", () => {
    expect(new Set(groupedEventActions())).toEqual(new Set(WEBHOOK_SUBSCRIBABLE_ACTIONS));
  });

  it("marks exactly the three enum-valued actions", () => {
    for (const action of WEBHOOK_ENUM_VALUED_ACTIONS) expect(carriesEnumValues(action)).toBe(true);
    expect(carriesEnumValues("COMMENT_ADDED_PUBLIC")).toBe(false);
    expect(carriesEnumValues("TICKET_FIELD_CHANGED")).toBe(false);
    expect(carriesEnumValues("TICKET_ASSIGNED")).toBe(false);
  });
});

describe("buildWebhookPayload", () => {
  it("carries ids, the number, the enum facts and a deep link", () => {
    const payload = buildWebhookPayload("wdl_1", event(), "https://desk.example.com");
    expect(payload).toEqual({
      id: "wdl_1",
      event: "TICKET_STATUS_CHANGED",
      auditSeq: "4211",
      occurredAt: "2026-09-20T09:30:00.000Z",
      entity: { type: "TICKET", id: TICKET.id },
      field: "status",
      from: "OPEN",
      to: "RESOLVED",
      ticket: TICKET,
      link: "https://desk.example.com/tickets/wm/1482",
    });
  });

  it("drops old/new for an action whose values are not enum members", () => {
    const reply = buildWebhookPayload(
      "wdl_2",
      event({
        action: "COMMENT_ADDED_PUBLIC",
        entityType: "COMMENT",
        entityId: "ckcomment01",
        fieldChanged: "body",
        oldValue: null,
        newValue: "Dear Jane, your wire of 1,200 went out this morning. — Alex",
      }),
      undefined,
    );
    expect(reply.field).toBe("body");
    expect(reply.from).toBeNull();
    expect(reply.to).toBeNull();
    expect(JSON.stringify(reply)).not.toContain("Dear Jane");
  });

  it("drops an assignee's user id, which TICKET_ASSIGNED carries in newValue", () => {
    const assigned = buildWebhookPayload(
      "wdl_3",
      event({ action: "TICKET_ASSIGNED", fieldChanged: "assigneeId", oldValue: null, newValue: "ckuser_alex_01" }),
      undefined,
    );
    expect(assigned.to).toBeNull();
    expect(JSON.stringify(assigned)).not.toContain("ckuser_alex_01");
  });

  it("omits the link when there is no ticket or no base URL", () => {
    expect(buildWebhookPayload("wdl_4", event({ ticket: null }), "https://desk.example.com").link).toBeNull();
    expect(buildWebhookPayload("wdl_5", event(), undefined).link).toBeNull();
    expect(ticketDeepLink(7, "https://desk.example.com/")).toBe("https://desk.example.com/tickets/wm/7");
  });

  it("is deterministic — the same inputs produce the same bytes and the same hash", () => {
    const a = serializeWebhookPayload(buildWebhookPayload("wdl_6", event(), "https://desk.example.com"));
    const b = serializeWebhookPayload(buildWebhookPayload("wdl_6", event(), "https://desk.example.com"));
    expect(a.body).toBe(b.body);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("assertPayloadPiiLight", () => {
  it("passes an ordinary payload", () => {
    expect(() => assertPayloadPiiLight(buildWebhookPayload("wdl_7", event(), "https://desk.example.com"))).not.toThrow();
  });

  it("refuses a payload that somehow acquired an address", () => {
    const payload = buildWebhookPayload("wdl_8", event(), undefined);
    const tampered = { ...payload, field: "requesterEmail", from: null, to: null, id: "jane@example.com" };
    expect(() => assertPayloadPiiLight(tampered)).toThrow(WebhookPayloadPiiError);
  });

  it("refuses a payload carrying something the PII sanitizer recognises", () => {
    const payload = buildWebhookPayload("wdl_9", event(), undefined);
    const tampered = { ...payload, from: "123-45-6789", to: null };
    expect(() => assertPayloadPiiLight(tampered)).toThrow(WebhookPayloadPiiError);
  });

  it("does not scan the deep link — a host name is not client data", () => {
    const payload = buildWebhookPayload("wdl_10", event(), "https://helpdesk.example.com");
    expect(() => assertPayloadPiiLight(payload)).not.toThrow();
  });
});

describe("schemas", () => {
  it("accepts a well-formed create", () => {
    const parsed = createWebhookEndpointSchema.parse({
      name: "  n8n ticket bridge ",
      url: "https://hooks.example.com/wm",
      events: ["TICKET_CREATED", "TICKET_CREATED", "TICKET_STATUS_CHANGED"],
    });
    expect(parsed.name).toBe("n8n ticket bridge");
    expect(parsed.events).toEqual(["TICKET_CREATED", "TICKET_STATUS_CHANGED"]);
  });

  it("refuses an endpoint with no events — it would receive nothing", () => {
    expect(() =>
      createWebhookEndpointSchema.parse({ name: "x", url: "https://hooks.example.com/wm", events: [] }),
    ).toThrow();
  });

  it("refuses an event outside the allowlist", () => {
    expect(() =>
      createWebhookEndpointSchema.parse({
        name: "x",
        url: "https://hooks.example.com/wm",
        events: ["COMMENT_ADDED_INTERNAL"],
      }),
    ).toThrow();
  });

  it("refuses a URL the SSRF guard would refuse, at the schema", () => {
    for (const url of ["http://hooks.example.com/wm", "https://localhost/wm", "https://169.254.169.254/"]) {
      expect(() => createWebhookEndpointSchema.parse({ name: "x", url, events: ["TICKET_CREATED"] }), url).toThrow();
    }
  });

  /**
   * Fix round 1. The refine tested only `.allowed` and attached one sentence about the SCHEME to every
   * rejection, so `https://webhook.invalid/hook` — https, and refused because `invalid` is a reserved
   * TLD — told the administrator to check their scheme. The guard's own `reason` is one field away.
   */
  it("surfaces the guard's own reason, not a blanket sentence about https", () => {
    const cases: Array<{ url: string; why: string }> = [
      { url: "https://webhook.invalid/hook", why: "reserved TLD on FORBIDDEN_HOST_SUFFIXES" },
      { url: "https://localhost/wm", why: "loopback name" },
      { url: "https://api.internal/wm", why: "internal suffix" },
      { url: "https://127.0.0.1/wm", why: "loopback literal" },
      { url: "https://10.0.0.5/wm", why: "private range" },
      { url: "https://169.254.169.254/", why: "link-local / cloud metadata" },
      { url: "https://100.64.0.1/wm", why: "CGNAT" },
    ];

    for (const { url, why } of cases) {
      const verdict = assertPublicHttpsUrl(url);
      expect(verdict.allowed, `${url} (${why}) should be refused`).toBe(false);
      expect(verdict.reason, `${url} (${why}) carries no reason`).toBeDefined();

      const parsed = createWebhookEndpointSchema.safeParse({ name: "x", url, events: ["TICKET_CREATED"] });
      expect(parsed.success, url).toBe(false);
      const message = parsed.success ? "" : (parsed.error.issues.find((i) => i.path[0] === "url")?.message ?? "");
      expect(message, `${url}: the schema must surface the guard's reason`).toBe(verdict.reason);
      // The scheme sentence is reserved for an actual scheme problem.
      if (url.startsWith("https://")) {
        expect(message, url).not.toBe("That URL is not an https address this desk may send to.");
      }
    }
  });

  it("still blames the scheme when the scheme is the problem", () => {
    const parsed = createWebhookEndpointSchema.safeParse({
      name: "x",
      url: "http://hooks.example.com/wm",
      events: ["TICKET_CREATED"],
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : (parsed.error.issues.find((i) => i.path[0] === "url")?.message ?? "");
    expect(message.toLowerCase()).toContain("https");
  });

  it("refuses an empty update patch", () => {
    expect(() => updateWebhookEndpointSchema.parse({ endpointId: "e1" })).toThrow();
    expect(updateWebhookEndpointSchema.parse({ endpointId: "e1", isActive: false }).isActive).toBe(false);
  });

  it("holds the revoke reason to the wave's twelve-character floor", () => {
    expect(() => revokeWebhookEndpointSchema.parse({ endpointId: "e1", reason: "too short" })).toThrow();
    expect(revokeWebhookEndpointSchema.parse({ endpointId: "e1", reason: "replaced by the v2 bridge" }).reason).toBe(
      "replaced by the v2 bridge",
    );
  });
});

describe("assertEndpointUrlAllowed", () => {
  it("allows a public name that resolves publicly", async () => {
    const verdict = await assertEndpointUrlAllowed("https://hooks.example.com/wm", async () => [
      { address: "93.184.216.34" },
    ]);
    expect(verdict.allowed).toBe(true);
  });

  it("refuses when ONE of several answers is private — the rebind shape", async () => {
    const verdict = await assertEndpointUrlAllowed("https://hooks.example.com/wm", async () => [
      { address: "93.184.216.34" },
      { address: "10.0.0.5" },
    ]);
    expect(verdict.allowed).toBe(false);
  });

  it("refuses when the resolver fails — 'we could not check' is not 'it is safe'", async () => {
    const verdict = await assertEndpointUrlAllowed("https://hooks.example.com/wm", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("resolved");
  });

  it("refuses when the name resolves to nothing", async () => {
    const verdict = await assertEndpointUrlAllowed("https://hooks.example.com/wm", async () => []);
    expect(verdict.allowed).toBe(false);
  });

  it("never consults the resolver for a syntactically refused URL", async () => {
    let called = false;
    const verdict = await assertEndpointUrlAllowed("http://hooks.example.com/wm", async () => {
      called = true;
      return [{ address: "93.184.216.34" }];
    });
    expect(verdict.allowed).toBe(false);
    expect(called).toBe(false);
  });

  it("judges an IP literal numerically without a resolver", async () => {
    let called = false;
    const lookup = async (): Promise<Array<{ address: string }>> => {
      called = true;
      return [{ address: "93.184.216.34" }];
    };
    expect((await assertEndpointUrlAllowed("https://93.184.216.34/wm", lookup)).allowed).toBe(true);
    expect((await assertEndpointUrlAllowed("https://10.0.0.5/wm", lookup)).allowed).toBe(false);
    expect(called).toBe(false);
  });
});

describe("DTO mapping", () => {
  it("never exposes the secret hash", () => {
    const dto = toWebhookEndpointDTO(
      {
        id: "e1",
        name: "bridge",
        url: "https://hooks.example.com/wm",
        secretPrefix: "ab12cd34",
        events: ["TICKET_CREATED"],
        isActive: true,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        updatedAt: new Date("2026-09-02T00:00:00Z"),
        revokedAt: null,
      },
      3,
    );
    expect(Object.keys(dto)).not.toContain("secretHash");
    expect(dto.secretPrefix).toBe("ab12cd34");
    expect(dto.recentFailures).toBe(3);
    expect(dto.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("renders auditSeq as a decimal string — JSON has no bigint", () => {
    const dto = toWebhookDeliveryDTO({
      id: "d1",
      endpointId: "e1",
      auditSeq: BigInt("9007199254740993"),
      eventAction: "TICKET_CREATED",
      status: "PENDING",
      attempts: 0,
      responseStatus: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(dto.auditSeq).toBe("9007199254740993");
  });
});
