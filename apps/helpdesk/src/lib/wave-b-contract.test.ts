/**
 * The Wave B foundation's own contract, as executable assertions.
 *
 * Every rule here is one thirteen slices code against, and each is the kind of thing that is easy to
 * state in a document and easy to drift from in a file:
 *
 *  - the enum mirrors equal the Prisma enums (tsc pins the TYPES; this pins the runtime VALUES);
 *  - the label maps are total over their enums, so no surface can render a raw value;
 *  - the capability matrix is what §5 says it is, group by group;
 *  - `formatDateTime` is pinned to the firm clock, so one instant reads the same on both sides of the
 *    server/client boundary;
 *  - the navigation derivation puts Wave B's surfaces where §2 of docs/MOBILE_FIRST.md says.
 */
import { describe, expect, it } from "vitest";
import { $Enums } from "@prisma/client";
import {
  API_TOKEN_SCOPES,
  API_TOKEN_SCOPE_LABELS,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  CAPABILITIES,
  CLIENT_FORBIDDEN_KEYS,
  CLIENT_RETRACTED_BODY,
  FOLLOWER_SOURCES,
  IDENTITY_VERIFICATION_METHODS,
  IDENTITY_VERIFICATION_METHOD_LABELS,
  IDENTITY_VERIFICATION_RESULTS,
  IDENTITY_VERIFICATION_RESULT_LABELS,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_DELIVERY_STATUS_LABELS,
  METRICS_EXCLUDED_STATUSES,
  MONEY_MOVEMENT_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_PREFS_DEFAULT,
  RESOLUTION_LABELS,
  REVIEW_VERDICTS,
  REVIEW_VERDICT_LABELS,
  SUPPRESSION_REASONS,
  SUPPRESSION_REASON_LABELS,
  SUSPENDED_INTAKE_REASONS,
  SUSPENDED_INTAKE_REASON_LABELS,
  TICKET_CATEGORIES,
  TICKET_LINK_KINDS,
  TICKET_LINK_INVERSE_LABELS,
  TICKET_LINK_KIND_LABELS,
  TICKET_RESOLUTIONS,
  TICKET_STATUSES,
  WAVE_B_LIMITS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DELIVERY_STATUS_LABELS,
} from "@/types/domain";
import type { Capability, OktaGroup, QueueKey } from "@/types/domain";
import { can } from "@/lib/rbac";
import { DISPLAY_TIME_ZONE_LABEL, formatDateTime } from "@/lib/format";
import { FIRM_TIME_ZONE_LABEL } from "@/lib/firm-time";
import { bottomTabsFor, navItemsFor, navOverflowFor } from "@/components/shell/nav-items";

const prismaValues = (e: Record<string, string>): string[] => Object.values(e);

describe("Wave B enum mirrors equal the Prisma enums (I15, at runtime as well as at compile time)", () => {
  const pairs: Array<[string, readonly string[], Record<string, string>]> = [
    ["TicketResolution", TICKET_RESOLUTIONS, $Enums.TicketResolution],
    ["NotificationKind", NOTIFICATION_KINDS, $Enums.NotificationKind],
    ["NotificationChannel", NOTIFICATION_CHANNELS, $Enums.NotificationChannel],
    ["FollowerSource", FOLLOWER_SOURCES, $Enums.FollowerSource],
    ["TicketLinkKind", TICKET_LINK_KINDS, $Enums.TicketLinkKind],
    ["WebhookDeliveryStatus", WEBHOOK_DELIVERY_STATUSES, $Enums.WebhookDeliveryStatus],
    ["ApiTokenScope", API_TOKEN_SCOPES, $Enums.ApiTokenScope],
    ["IdentityVerificationMethod", IDENTITY_VERIFICATION_METHODS, $Enums.IdentityVerificationMethod],
    ["IdentityVerificationResult", IDENTITY_VERIFICATION_RESULTS, $Enums.IdentityVerificationResult],
    ["ReviewVerdict", REVIEW_VERDICTS, $Enums.ReviewVerdict],
    ["SuppressionReason", SUPPRESSION_REASONS, $Enums.SuppressionReason],
  ];
  for (const [name, mirror, prisma] of pairs) {
    it(`${name} — same values, same order`, () => {
      expect([...mirror]).toEqual(prismaValues(prisma));
    });
  }

  it("the widened Wave A enums still match after Wave B appended to them", () => {
    expect([...TICKET_STATUSES]).toEqual(prismaValues($Enums.TicketStatus));
    expect([...MESSAGE_DELIVERY_STATUSES]).toEqual(prismaValues($Enums.MessageDeliveryStatus));
    expect([...SUSPENDED_INTAKE_REASONS]).toEqual(prismaValues($Enums.SuspendedIntakeReason));
    expect([...AUDIT_ACTIONS]).toEqual(prismaValues($Enums.AuditAction));
    expect([...AUDIT_ENTITY_TYPES]).toEqual(prismaValues($Enums.AuditEntityType));
  });

  it("append-only: VOIDED is LAST in TicketStatus, so no stored row changed meaning", () => {
    expect(TICKET_STATUSES[TICKET_STATUSES.length - 1]).toBe("VOIDED");
    expect(TICKET_STATUSES.indexOf("CLOSED")).toBe(5);
  });
});

describe("label maps are total — the UI never renders a raw enum value", () => {
  const maps: Array<[string, readonly string[], Readonly<Record<string, string>>]> = [
    ["TicketResolution", TICKET_RESOLUTIONS, RESOLUTION_LABELS],
    ["NotificationKind", NOTIFICATION_KINDS, NOTIFICATION_KIND_LABELS],
    ["NotificationChannel", NOTIFICATION_CHANNELS, NOTIFICATION_CHANNEL_LABELS],
    ["TicketLinkKind", TICKET_LINK_KINDS, TICKET_LINK_KIND_LABELS],
    ["TicketLinkKind (inverse)", TICKET_LINK_KINDS, TICKET_LINK_INVERSE_LABELS],
    ["WebhookDeliveryStatus", WEBHOOK_DELIVERY_STATUSES, WEBHOOK_DELIVERY_STATUS_LABELS],
    ["ApiTokenScope", API_TOKEN_SCOPES, API_TOKEN_SCOPE_LABELS],
    ["IdentityVerificationMethod", IDENTITY_VERIFICATION_METHODS, IDENTITY_VERIFICATION_METHOD_LABELS],
    ["IdentityVerificationResult", IDENTITY_VERIFICATION_RESULTS, IDENTITY_VERIFICATION_RESULT_LABELS],
    ["ReviewVerdict", REVIEW_VERDICTS, REVIEW_VERDICT_LABELS],
    ["SuppressionReason", SUPPRESSION_REASONS, SUPPRESSION_REASON_LABELS],
    ["MessageDeliveryStatus", MESSAGE_DELIVERY_STATUSES, MESSAGE_DELIVERY_STATUS_LABELS],
    ["SuspendedIntakeReason", SUSPENDED_INTAKE_REASONS, SUSPENDED_INTAKE_REASON_LABELS],
  ];
  for (const [name, values, labels] of maps) {
    it(`${name} has a label for every value and no extras`, () => {
      expect(Object.keys(labels).sort()).toEqual([...values].sort());
      for (const v of values) expect(labels[v]?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it("RELATED reads the same from both ends; the directed kinds invert", () => {
    expect(TICKET_LINK_INVERSE_LABELS.RELATED).toBe(TICKET_LINK_KIND_LABELS.RELATED);
    expect(TICKET_LINK_INVERSE_LABELS.DUPLICATE_OF).not.toBe(TICKET_LINK_KIND_LABELS.DUPLICATE_OF);
    expect(TICKET_LINK_INVERSE_LABELS.BLOCKS).not.toBe(TICKET_LINK_KIND_LABELS.BLOCKS);
  });
});

describe("the code-owned tables Wave B adds", () => {
  it("METRICS_EXCLUDED_STATUSES is VOIDED alone — a CLOSED ticket is real work and still counts", () => {
    expect([...METRICS_EXCLUDED_STATUSES]).toEqual(["VOIDED"]);
    for (const s of METRICS_EXCLUDED_STATUSES) expect(TICKET_STATUSES).toContain(s);
  });

  it("MONEY_MOVEMENT_CATEGORIES are the five where an impostor's success is irreversible", () => {
    expect([...MONEY_MOVEMENT_CATEGORIES]).toEqual([
      "WIRE_TRANSFER",
      "CASH_MOVEMENT",
      "ACCOUNT_CLOSURE",
      "ADDRESS_CHANGE",
      "RETIREMENT_DISTRIBUTION",
    ]);
    for (const c of MONEY_MOVEMENT_CATEGORIES) expect(TICKET_CATEGORIES).toContain(c);
  });

  it("NOTIFICATION_PREFS_DEFAULT never switches IN_APP off — 'you were told' has to stay provable", () => {
    for (const [kind, channels] of Object.entries(NOTIFICATION_PREFS_DEFAULT.channels)) {
      expect(NOTIFICATION_KINDS, `${kind} is not a NotificationKind`).toContain(kind);
      expect(Object.keys(channels ?? {}), `${kind} may not configure IN_APP`).not.toContain("IN_APP");
    }
    // An unset preference column means THESE defaults, never "notify nothing".
    expect(NOTIFICATION_PREFS_DEFAULT.digest).toBe(true);
    expect(NOTIFICATION_PREFS_DEFAULT.channels.SLA_BREACH?.SLACK_DM).toBe(true);
  });

  it("WAVE_B_LIMITS agrees with the DB CHECKs it mirrors", () => {
    expect(WAVE_B_LIMITS.notificationPreviewChars).toBe(200);
    expect(WAVE_B_LIMITS.reasonMinChars).toBe(12);
    expect(WAVE_B_LIMITS.reasonMaxChars).toBe(2000);
    expect(WAVE_B_LIMITS.bulkMaxTickets).toBeGreaterThan(0);
  });

  it("the client-facing placeholder says a message was withdrawn and nothing about its content", () => {
    expect(CLIENT_RETRACTED_BODY).toBe("This message was withdrawn by your service team.");
    // `retracted` is the ONE Wave B field a client is owed, so it must NOT be on the forbidden list.
    expect(CLIENT_FORBIDDEN_KEYS).not.toContain("retracted");
    // Everything the retraction table itself holds IS forbidden.
    for (const key of ["retraction", "retractedById", "reviews", "reviewerId", "verdict"]) {
      expect(CLIENT_FORBIDDEN_KEYS, `${key} must never reach a client payload`).toContain(key);
    }
  });
});

describe("the Wave B capability matrix (CONTRACT §5)", () => {
  const OPS: OktaGroup[] = ["ops_team"];
  const ADV: OktaGroup[] = ["advisors"];
  const CS: OktaGroup[] = ["client_services"];
  const CO: OktaGroup[] = ["compliance_officers"];
  const NONE: OktaGroup[] = [];

  const grantedTo = (cap: Capability, q?: QueueKey): string =>
    [
      ["ops", OPS],
      ["adv", ADV],
      ["cs", CS],
      ["co", CO],
      ["none", NONE],
    ]
      .filter(([, g]) => can(g as OktaGroup[], cap, q ? { queueKey: q } : undefined))
      .map(([label]) => label)
      .join(",");

  it("the four ops-only administration capabilities are exactly ops-only", () => {
    for (const cap of ["sla:admin", "webhooks:admin", "tokens:admin", "suppression:admin"] as const) {
      expect(grantedTo(cap), cap).toBe("ops");
    }
  });

  it("reports:read is every group that can read a queue; the inbox is every group at all", () => {
    expect(grantedTo("reports:read")).toBe("ops,adv,cs,co");
    expect(grantedTo("inbox")).toBe("ops,adv,cs,co");
  });

  it("flags:read is the held-mail audience: the admins who fix it and the officers who must know", () => {
    expect(grantedTo("flags:read")).toBe("ops,co");
  });

  it("review:stamp is WIDER than audit:view — supervision is a desk-lead duty before a CCO one", () => {
    expect(grantedTo("review:stamp")).toBe("ops,co");
    expect(grantedTo("audit:view")).toBe("co");
  });

  it("identity:verify, links:write and bulk:apply are queue WRITE, so compliance holds none of them", () => {
    for (const cap of ["identity:verify", "links:write", "bulk:apply"] as const) {
      expect(grantedTo(cap, "OPERATIONS"), `${cap} on OPERATIONS`).toBe("ops");
      expect(grantedTo(cap, "CLIENT_SERVICE"), `${cap} on CLIENT_SERVICE`).toBe("cs");
      expect(grantedTo(cap, "ADVICE"), `${cap} on ADVICE`).toBe("adv");
    }
  });

  it("ticket:void is ops_team AND queue WRITE — so ops voids only in OPERATIONS", () => {
    expect(grantedTo("ticket:void", "OPERATIONS")).toBe("ops");
    expect(grantedTo("ticket:void", "CLIENT_SERVICE")).toBe("");
    expect(grantedTo("ticket:void", "ADVICE")).toBe("");
  });

  it("every queue-scoped Wave B capability is DENIED without a queue in the context", () => {
    for (const cap of ["identity:verify", "ticket:void", "links:write", "bulk:apply"] as const) {
      expect(can(["ops_team"], cap), cap).toBe(false);
    }
  });

  it("CAPABILITIES has no duplicates and `can` is exhaustive over it", () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    for (const cap of CAPABILITIES) {
      expect(() => can(["ops_team"], cap, { queueKey: "OPERATIONS", fromQueueKey: "OPERATIONS", toQueueKey: "ADVICE" }))
        .not.toThrow();
    }
  });
});

describe("rendered instants are on the firm clock (Decision #104)", () => {
  it("formatDateTime prints Eastern with an explicit zone label, not the ambient zone", () => {
    // 14:30 UTC on 20 September is 10:30 in New York (EDT). The label is what makes the reading
    // self-describing for someone in Denver.
    expect(formatDateTime("2026-09-20T14:30:00.000Z")).toBe("Sep 20, 2026 10:30 ET");
    expect(DISPLAY_TIME_ZONE_LABEL).toBe(FIRM_TIME_ZONE_LABEL);
  });

  it("is stable across a DST boundary — the zone does the arithmetic, not us", () => {
    // 20:00 UTC on 1 November 2026 is 15:00 EST (after the fall-back); on 1 July it is 16:00 EDT.
    expect(formatDateTime("2026-11-01T20:00:00.000Z")).toBe("Nov 1, 2026 15:00 ET");
    expect(formatDateTime("2026-07-01T20:00:00.000Z")).toBe("Jul 1, 2026 16:00 ET");
  });

  it("an unreadable instant renders as an em dash rather than 'Invalid Date'", () => {
    expect(formatDateTime("nonsense")).toBe("—");
  });

  it("the same instant renders identically however it is passed in (server vs client boundary)", () => {
    const iso = "2026-09-20T14:30:00.000Z";
    expect(formatDateTime(new Date(iso))).toBe(formatDateTime(iso));
  });
});

describe("navigation places Wave B's surfaces where docs/MOBILE_FIRST.md §2 says (Decision #108)", () => {
  it("the bottom tab bar is unchanged: no inbox tab, no reports tab, never more than five", () => {
    for (const groups of [
      ["ops_team"],
      ["advisors"],
      ["client_services"],
      ["compliance_officers"],
      ["ops_team", "client_services", "advisors"],
      ["ops_team", "compliance_officers"],
      [],
    ] as OktaGroup[][]) {
      const tabs = bottomTabsFor(navItemsFor({ groups }));
      expect(tabs.length, JSON.stringify(groups)).toBeLessThanOrEqual(5);
      expect(tabs).not.toContain("inbox");
      expect(tabs).not.toContain("reports");
      expect(tabs[0]).toBe("dashboard");
      expect(tabs[tabs.length - 1]).toBe("account");
    }
  });

  it("the dual-role officer keeps the Audit tab — the trade a sixth tab would have made", () => {
    expect(bottomTabsFor(navItemsFor({ groups: ["ops_team", "compliance_officers"] }))).toContain("audit");
  });

  it("Reports and Reply reviews overflow into the Account sheet, gated by their own capabilities", () => {
    expect(navOverflowFor(navItemsFor({ groups: ["client_services"] })).map((o) => o.key)).toEqual(["reports"]);
    expect(navOverflowFor(navItemsFor({ groups: ["ops_team"] })).map((o) => o.key)).toEqual(["reports", "reviews"]);
    expect(navOverflowFor(navItemsFor({ groups: ["compliance_officers"] })).map((o) => o.key)).toEqual([
      "reports",
      "reviews",
    ]);
    expect(navOverflowFor(navItemsFor({ groups: [] }))).toEqual([]);
  });

  it("the inbox badge is absent at zero, on a missing count and on a non-finite one", () => {
    expect(navItemsFor({ groups: ["ops_team"] }).inboxUnread).toBeUndefined();
    expect(navItemsFor({ groups: ["ops_team"] }, { inboxUnread: 0 }).inboxUnread).toBeUndefined();
    expect(navItemsFor({ groups: ["ops_team"] }, { inboxUnread: Number.NaN }).inboxUnread).toBeUndefined();
    expect(navItemsFor({ groups: ["ops_team"] }, { inboxUnread: 17 }).inboxUnread).toBe(17);
  });
});
