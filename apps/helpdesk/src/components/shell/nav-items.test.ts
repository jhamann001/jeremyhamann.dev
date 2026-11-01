/**
 * S4 — pure navigation derivation (docs/MOBILE_FIRST.md §2 persona × tab matrix).
 * `AppSidebar` and `BottomNav` both render from these helpers, so pinning them pins both navigations.
 */
import { describe, expect, it } from "vitest";
import type { DevPersonaKey, OktaGroup } from "@/types/domain";
import { DEV_PERSONAS } from "@/lib/dev-login";
import { isPathAllowed } from "@/lib/rbac";
import {
  type BottomTab,
  adminOverflowFor,
  bottomTabsFor,
  hidesBottomNav,
  isActivePath,
  navItemsFor,
} from "@/components/shell/nav-items";

const ALL_QUEUES = ["/queues/operations", "/queues/client-service", "/queues/advice"] as const;

/** docs/MOBILE_FIRST.md §2 — dev personas as seeded in src/lib/dev-login.ts. */
const MATRIX: Readonly<Record<DevPersonaKey, { queues: readonly string[]; tabs: readonly BottomTab[] }>> = {
  ops: { queues: ALL_QUEUES, tabs: ["dashboard", "queues", "new", "account"] },
  advisor: { queues: ALL_QUEUES, tabs: ["dashboard", "queues", "new", "account"] },
  cs: { queues: ["/queues/operations", "/queues/client-service"], tabs: ["dashboard", "queues", "new", "account"] },
  compliance: { queues: ALL_QUEUES, tabs: ["dashboard", "queues", "audit", "account"] },
};

describe("navItemsFor / bottomTabsFor — persona × tab matrix", () => {
  it("covers every seeded persona", () => {
    expect(DEV_PERSONAS.map((p) => p.key).sort()).toEqual(Object.keys(MATRIX).sort());
  });

  for (const persona of DEV_PERSONAS) {
    it(`${persona.key}: ${MATRIX[persona.key].tabs.join(" · ")} (${MATRIX[persona.key].queues.length} queues)`, () => {
      const items = navItemsFor({ groups: persona.groups });
      expect(items.queues.map((q) => q.href)).toEqual(MATRIX[persona.key].queues);
      expect(bottomTabsFor(items)).toEqual(MATRIX[persona.key].tabs);
    });
  }

  it("labels come from QUEUE_LABELS and hrefs from queueSlug, in QUEUE_KEYS order", () => {
    expect(navItemsFor({ groups: ["ops_team"] }).queues).toEqual([
      { key: "OPERATIONS", href: "/queues/operations", label: "Operations" },
      { key: "CLIENT_SERVICE", href: "/queues/client-service", label: "Client Service" },
      { key: "ADVICE", href: "/queues/advice", label: "Advice" },
    ]);
  });

  it("the Admin section: Macros for ops and compliance, Users and the credential pages for ops only (Decisions #68, #83, #102)", () => {
    expect(navItemsFor({ groups: ["ops_team"] }).admin.map((a) => a.key)).toEqual([
      "macros",
      "users",
      "intake",
      // the policy the desk runs on, the two credential surfaces, the suppression list, and
      // the read-only capability view.
      "sla",
      "webhooks",
      "api-tokens",
      "suppression",
      "flags",
    ]);
    // Compliance reviews held mail but administers no users: read the refusals, release none of them
    // without WRITE on the destination queue (`intake:release`). Wave B adds exactly one entry for
    // them — the read-only capability view — and none of the four that mint, revoke or stop anything.
    expect(navItemsFor({ groups: ["compliance_officers"] }).admin).toEqual([
      { key: "macros", href: "/admin/macros", label: "Macros" },
      { key: "intake", href: "/admin/intake", label: "Held mail" },
      { key: "flags", href: "/admin/flags", label: "Capabilities" },
    ]);
    expect(navItemsFor({ groups: ["advisors"] }).admin).toEqual([]);
    expect(navItemsFor({ groups: ["client_services"] }).admin).toEqual([]);
    expect(navItemsFor({ groups: [] }).admin).toEqual([]);
  });

  it("Wave A — every admin nav entry is one isPathAllowed grants that persona (the nav cannot offer a 404)", () => {
    for (const persona of DEV_PERSONAS) {
      for (const item of navItemsFor({ groups: persona.groups }).admin) {
        expect(isPathAllowed(item.href, persona.groups), `${persona.key} → ${item.href}`).toBe(true);
      }
    }
  });

  it("Wave A — Admin never becomes a sixth bottom tab; it overflows into the Account sheet", () => {
    for (const persona of DEV_PERSONAS) {
      const items = navItemsFor({ groups: persona.groups });
      const tabs = bottomTabsFor(items);
      expect(tabs.length).toBeLessThanOrEqual(5);
      expect(tabs).not.toContain("admin");
      expect(adminOverflowFor(items)).toEqual(items.admin);
    }
    // The widest real persona (dual role) still holds the five-tab ceiling with EIGHT admin entries —
    // which is the point of the overflow rule: the Admin block is a vertical list inside a sheet, and
    // it can grow without ever touching the thumb rail. Wave B added five entries and no tabs.
    const dual: OktaGroup[] = ["ops_team", "compliance_officers"];
    const items = navItemsFor({ groups: dual });
    expect(bottomTabsFor(items)).toHaveLength(5);
    expect(adminOverflowFor(items).map((a) => a.key)).toEqual([
      "macros",
      "users",
      "intake",
      "sla",
      "webhooks",
      "api-tokens",
      "suppression",
      "flags",
    ]);
  });

  it("Wave A fix round 2 — the held-mail backlog rides on the intake entry as `count`", () => {
    const withCount = navItemsFor({ groups: ["ops_team"] }, { heldIntake: 11 });
    expect(withCount.admin.find((a) => a.key === "intake")).toEqual({
      key: "intake",
      href: "/admin/intake",
      label: "Held mail",
      count: 11,
    });
    // Compliance reviews held mail too, and sees the same number.
    expect(navItemsFor({ groups: ["compliance_officers"] }, { heldIntake: 3 }).admin.find((a) => a.key === "intake")).toEqual({
      key: "intake",
      href: "/admin/intake",
      label: "Held mail",
      count: 3,
    });
    // Only the entry whose page shows that work carries it.
    for (const item of withCount.admin.filter((a) => a.key !== "intake")) {
      expect(item.count, `${item.key} must not carry a count`).toBeUndefined();
    }
    // The overflow surface hands the phone exactly the same array, badge and all.
    expect(adminOverflowFor(withCount)).toEqual(withCount.admin);
  });

  it("Wave A fix round 2 — no badge for an empty backlog, an absent count, or a nonsense one", () => {
    const intake = (counts?: { heldIntake?: number }) =>
      navItemsFor({ groups: ["ops_team"] }, counts).admin.find((a) => a.key === "intake");
    // An absent count is not the same fact as a zero one: the layout also omits it when the read fails.
    expect(intake()?.count, "no counts argument at all").toBeUndefined();
    expect(intake({})?.count, "counts object without the key").toBeUndefined();
    expect(intake({ heldIntake: undefined })?.count).toBeUndefined();
    expect(intake({ heldIntake: 0 })?.count, "a 0 badge is noise, not information").toBeUndefined();
    expect(intake({ heldIntake: -4 })?.count, "a negative count is a bug upstream, not a badge").toBeUndefined();
    expect(intake({ heldIntake: Number.NaN })?.count).toBeUndefined();
    expect(intake({ heldIntake: Number.POSITIVE_INFINITY })?.count).toBeUndefined();
    expect(intake({ heldIntake: 2.7 })?.count, "rows are whole messages").toBe(2);
    expect(intake({ heldIntake: 1 })?.count).toBe(1);
  });

  it("Wave A fix round 2 — a count never reaches a viewer without `intake:review`, and never moves the tabs", () => {
    for (const groups of [["advisors"], ["client_services"], []] as OktaGroup[][]) {
      expect(navItemsFor({ groups }, { heldIntake: 99 }).admin).toEqual([]);
    }
    const ops = navItemsFor({ groups: ["ops_team"] });
    const opsWithCount = navItemsFor({ groups: ["ops_team"] }, { heldIntake: 99 });
    expect(bottomTabsFor(opsWithCount)).toEqual(bottomTabsFor(ops));
    expect(opsWithCount.queues).toEqual(ops.queues);
  });

  it("compliance never gets New (cannot create) but always gets Audit", () => {
    const items = navItemsFor({ groups: ["compliance_officers"] });
    expect(items).toMatchObject({ canCreate: false, showAudit: true });
    expect(bottomTabsFor(items)).not.toContain("new");
  });

  it("supervisor (ops + cs + advisors) is NOT dual-role: no Audit tab, four tabs", () => {
    const items = navItemsFor({ groups: ["ops_team", "client_services", "advisors"] });
    expect(items.showAudit).toBe(false);
    expect(bottomTabsFor(items)).toHaveLength(4);
  });

  it("a hand-built dual-role viewer (compliance plus an operational group) is the only way to five tabs", () => {
    const groups: OktaGroup[] = ["ops_team", "compliance_officers"];
    const items = navItemsFor({ groups });
    expect(items).toMatchObject({ canCreate: true, showAudit: true });
    expect(bottomTabsFor(items)).toEqual(["dashboard", "queues", "new", "audit", "account"]);
  });

  it("zero recognised groups → Dashboard and Account only (the pages still redirect to /no-access)", () => {
    const items = navItemsFor({ groups: [] });
    // `showInbox` is `groups.length > 0`, so zero groups sees no inbox either — the notification
    // layer is not a way around §b.3. `showReports` and `showReviews` are false for the same reason.
    expect(items).toEqual({
      queues: [],
      canCreate: false,
      showAudit: false,
      showInbox: false,
      showReports: false,
      showReviews: false,
      admin: [],
    });
    expect(bottomTabsFor(items)).toEqual(["dashboard", "account"]);
  });

  it("never exceeds five tabs and always starts with Dashboard and ends with Account", () => {
    const groupSets: OktaGroup[][] = [
      [],
      ["ops_team"],
      ["advisors"],
      ["client_services"],
      ["compliance_officers"],
      ["ops_team", "advisors", "client_services", "compliance_officers"],
    ];
    for (const groups of groupSets) {
      const tabs = bottomTabsFor(navItemsFor({ groups }));
      expect(tabs.length).toBeLessThanOrEqual(5);
      expect(tabs[0]).toBe("dashboard");
      expect(tabs[tabs.length - 1]).toBe("account");
      expect(new Set(tabs).size).toBe(tabs.length);
    }
  });
});

describe("isActivePath", () => {
  it("exact mode matches only the path itself", () => {
    expect(isActivePath("/dashboard", "/dashboard", true)).toBe(true);
    expect(isActivePath("/dashboard/x", "/dashboard", true)).toBe(false);
    expect(isActivePath("/tickets/new", "/tickets/new", true)).toBe(true);
  });

  it("prefix mode matches the path and its children, not siblings sharing a prefix", () => {
    expect(isActivePath("/queues/operations", "/queues/operations")).toBe(true);
    expect(isActivePath("/queues/operations/anything", "/queues/operations")).toBe(true);
    expect(isActivePath("/queues/operations-archive", "/queues/operations")).toBe(false);
    expect(isActivePath("/queues", "/queues/operations")).toBe(false);
  });

  it("the Queues tab is active on any /queues/* path", () => {
    expect(isActivePath("/queues/advice", "/queues")).toBe(true);
    expect(isActivePath("/dashboard", "/queues")).toBe(false);
  });
});

describe("hidesBottomNav — §2 route rule", () => {
  it("hides on every /tickets/** route (the StickyActionBar owns the bottom edge there)", () => {
    expect(hidesBottomNav("/tickets/new")).toBe(true);
    expect(hidesBottomNav("/tickets/cmfabc123def")).toBe(true);
    expect(hidesBottomNav("/tickets/cmfabc123def/anything")).toBe(true);
  });

  it("shows everywhere else", () => {
    for (const p of ["/dashboard", "/queues/operations", "/compliance/audit", "/tickets", "/ticketsx/1", "/"]) {
      expect(hidesBottomNav(p)).toBe(false);
    }
  });
});
