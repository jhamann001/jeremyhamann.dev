/**
 * Unit tests for the webhook admin form helpers.
 *
 * The parity assertion that matters most — that the picker's grouped list and the SERVER's allowlist
 * are the same set — lives in `src/server/webhooks.test.ts` instead, not here: G1 forbids anything
 * under `src/components/**` from value-importing a non-`.actions` server module, and a test file is not
 * exempt from that rule (a test is the one place where "it is only a test" quietly becomes a client
 * bundle importing Prisma). This file covers everything that can be checked from the component side.
 */
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@/types/domain";
import {
  DELIVERY_STATUS_VARIANTS,
  ENDPOINT_HEALTH_LABELS,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_LABELS,
  endpointHealth,
  eventLabel,
  groupedEventActions,
  shortUrl,
  urlFieldError,
  validationToastMessage,
} from "@/components/admin/webhooks/webhook-form-support";

describe("the event picker", () => {
  it("lists each event once, in one group", () => {
    const actions = groupedEventActions();
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("labels every offered event", () => {
    for (const action of groupedEventActions()) {
      expect(WEBHOOK_EVENT_LABELS[action], action).toBeTypeOf("string");
      expect(eventLabel(action)).not.toBe(action);
    }
  });

  it("falls back to the raw action name for anything unlabelled", () => {
    expect(eventLabel("TICKET_VIEWED")).toBe("TICKET_VIEWED");
  });

  it("names only real audit actions", () => {
    for (const action of groupedEventActions()) expect(AUDIT_ACTIONS).toContain(action);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(WEBHOOK_EVENT_GROUPS)).toBe(true);
    for (const group of WEBHOOK_EVENT_GROUPS) {
      expect(Object.isFrozen(group)).toBe(true);
      expect(Object.isFrozen(group.actions)).toBe(true);
    }
  });

  it("gives every group a hint, so the picker explains itself without a tooltip (R10)", () => {
    for (const group of WEBHOOK_EVENT_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.hint.length).toBeGreaterThan(0);
      expect(group.actions.length).toBeGreaterThan(0);
    }
  });
});

describe("endpointHealth", () => {
  it("reads revoked before paused", () => {
    expect(endpointHealth({ isActive: true, revokedAt: null })).toBe("live");
    expect(endpointHealth({ isActive: false, revokedAt: null })).toBe("paused");
    expect(endpointHealth({ isActive: true, revokedAt: "2026-09-20T00:00:00Z" })).toBe("revoked");
    expect(endpointHealth({ isActive: false, revokedAt: "2026-09-20T00:00:00Z" })).toBe("revoked");
  });

  it("labels all three states", () => {
    expect(Object.keys(ENDPOINT_HEALTH_LABELS).sort()).toEqual(["live", "paused", "revoked"]);
  });
});

describe("DELIVERY_STATUS_VARIANTS", () => {
  it("covers every delivery status", () => {
    expect(Object.keys(DELIVERY_STATUS_VARIANTS).sort()).toEqual(["DEAD", "FAILED", "PENDING", "SENT"]);
  });
});

describe("shortUrl", () => {
  it("keeps the host and a short path", () => {
    expect(shortUrl("https://hooks.example.com/wm")).toBe("hooks.example.com/wm");
  });

  it("drops a bare root path", () => {
    expect(shortUrl("https://hooks.example.com/")).toBe("hooks.example.com");
  });

  it("truncates rather than wrapping a phone layout", () => {
    const short = shortUrl(`https://hooks.example.com/${"a".repeat(200)}`, 30);
    expect(short).toHaveLength(30);
    expect(short.endsWith("…")).toBe(true);
  });

  it("does not throw on something that is not a URL", () => {
    expect(shortUrl("not a url")).toBe("not a url");
    expect(shortUrl("x".repeat(100), 10)).toHaveLength(10);
  });
});

describe("urlFieldError", () => {
  it("passes an https URL", () => {
    expect(urlFieldError("https://hooks.example.com/wm")).toBeNull();
  });

  it("catches the obvious mistakes before a round trip", () => {
    expect(urlFieldError("")).toContain("required");
    expect(urlFieldError("hooks.example.com/wm")).toContain("https://");
    expect(urlFieldError("http://hooks.example.com/wm")).toContain("Only https");
    expect(urlFieldError("https://user:pass@hooks.example.com/wm")).toContain("Credentials");
  });

  it("leaves the network-shaped judgements to the server", () => {
    // The local check is a convenience; `assertPublicHttpsUrl` and the DNS pass are authoritative, and
    // a private literal must still reach them so the refusal reason comes from one place.
    expect(urlFieldError("https://10.0.0.5/wm")).toBeNull();
  });
});

/**
 * Fix round 2. Registering `https://webhook.invalid/hook` failed with the guard's reason in the URL
 * field and the bare "Invalid input" in the toast, while the SAME sheet's local failure a moment
 * earlier said "Please correct the highlighted fields". The toast is the line an operator reads first,
 * so it has to carry the reason when there is exactly one.
 */
describe("validationToastMessage", () => {
  it("surfaces a single field's reason verbatim, not the generic action message", () => {
    const reason = "Names ending in .invalid are reserved and can never resolve to a real host — use the receiving system's own hostname.";
    expect(validationToastMessage({ url: [reason] }, "Invalid input")).toBe(reason);
  });

  it("prefers the whole-form message when the server sends one", () => {
    expect(validationToastMessage({ _form: ["Nothing to change."], url: ["ignored"] }, "Invalid input")).toBe(
      "Nothing to change.",
    );
  });

  it("summarises several fields the way the local path does, rather than concatenating them", () => {
    expect(
      validationToastMessage({ name: ["A name is required."], url: ["That URL has no host."] }, "Invalid input"),
    ).toBe("Please correct the highlighted fields");
  });

  it("falls back to the action message only when nothing usable is attached", () => {
    expect(validationToastMessage(undefined, "Invalid input")).toBe("Invalid input");
    expect(validationToastMessage({}, "Invalid input")).toBe("Invalid input");
    expect(validationToastMessage({ url: [], _form: [] }, "Invalid input")).toBe("Invalid input");
    expect(validationToastMessage({ url: ["  "] }, "Invalid input")).toBe("Invalid input");
  });
});
