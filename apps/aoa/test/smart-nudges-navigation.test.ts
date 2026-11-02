import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Role } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, pathname } = vi.hoisted(() => ({ auth: vi.fn(), pathname: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth, signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: pathname,
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
}));
vi.mock("@/components/shell/Topbar", () => ({ Topbar: () => null, NotificationsMenu: () => null }));
vi.mock("@/components/shell/RosterNotifications", () => ({ RosterNotifications: () => null }));
vi.mock("@/components/shell/SessionTimeout", () => ({ SessionTimeout: () => null }));
vi.mock("@/components/navigation/ListNavigationBoundary", () => ({ ListNavigationBoundary: () => null }));

import AuthenticatedLayout from "@/app/(authenticated)/layout";
import WorkflowLayout from "@/app/(authenticated)/(workflow)/layout";
import SmartNudgesPage from "@/app/(authenticated)/(workflow)/smart-nudges/page";
import { ClientRemindersPanel } from "@/components/client-portrait/ClientRemindersPanel";
import { Sidebar } from "@/components/shell/Sidebar";
import { SmartNudgesView } from "@/components/smart-nudges/SmartNudgesView";
import { WorkflowProvider } from "@/components/workflow";
import { getWorkflowSeed } from "@/lib/data/workflow";
import type { Decision, Nudge } from "@/lib/data/workflow-types";

const roles = Object.values(Role);
const nudges: Nudge[] = (["ready", "scheduled", "sent"] as const).map((status) => ({
  id: `synthetic-nudge-${status}`,
  client: "Synthetic client",
  channel: "email",
  subject: `Synthetic ${status} reminder`,
  when: "Synthetic reminder timing",
  templateId: "synthetic-template",
  status,
  body: `Synthetic ${status} reminder content`,
}));
const decisions: Decision[] = [{
  id: "synthetic-decision",
  householdId: "synthetic-household",
  householdName: "Synthetic household",
  meeting: "Synthetic meeting",
  items: [{
    id: "synthetic-decision-item",
    what: "Synthetic household decision",
    rec: "Synthetic recommendation",
    owner: { kind: "group", label: "Operations" },
    status: "open",
    downstream: "Synthetic downstream action",
    tasks: [],
  }],
}];

beforeEach(() => {
  vi.clearAllMocks();
  pathname.mockReturnValue("/smart-nudges");
  vi.stubEnv("SMART_NUDGES_REQUIREMENTS_RESOLVER", "0");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("temporarily hidden Smart Nudges entry points", () => {
  describe.each([false, true])("sidebar optional navigation enabled=%s", (enabled) => {
    it.each(roles)("hides Smart Nudges but retains neighboring links for %s", (role) => {
      const html = renderToStaticMarkup(React.createElement(Sidebar, {
        role,
        crmIdentityReads: enabled,
        crmRelationships: enabled,
        crmReporting: enabled,
        dataHealth: enabled,
        operationsTools: enabled,
      }));

      expect(html).not.toContain('href="/smart-nudges"');
      expect(html).not.toContain("Smart Nudges");
      expect(html).not.toContain('href="/decision-center"');
      expect(html).toContain('href="/tasks"');
      expect(html).toContain('href="/client-portrait"');
      expect(html).toContain("Workflow");
    });
  });

  it("keeps every reminder status without a Decision Center or nudge shortcut", () => {
    const html = renderToStaticMarkup(React.createElement(ClientRemindersPanel, {
      clientName: "Synthetic client", decisions, nudges,
    }));

    expect(html).not.toContain('href="/smart-nudges"');
    expect(html).not.toContain("Smart Nudges");
    expect(html).toContain("Client-facing reminders");
    expect(html).toContain("Advisor lens");
    for (const nudge of nudges) {
      expect(html).toContain(nudge.subject);
      expect(html).toContain(nudge.body);
    }
    expect(html).toContain("Synthetic reminder timing");
    expect(html).toContain("Synthetic household decision");
    expect(html).toContain("Synthetic recommendation");
    expect(html).not.toContain('href="/decision-center"');
  });

  it("preserves both empty reminder-panel states", () => {
    const html = renderToStaticMarkup(React.createElement(ClientRemindersPanel, {
      clientName: "Synthetic client", decisions: [], nudges: [],
    }));

    expect(html).toContain("No client-facing reminders queued for Synthetic client.");
    expect(html).toContain("No decisions for this household yet.");
    expect(html).not.toContain('href="/smart-nudges"');
  });
});

describe("Smart Nudges direct-route preservation", () => {
  it.each(["0", "1"])("keeps the existing requirements flag contract (%s)", (flag) => {
    vi.stubEnv("SMART_NUDGES_REQUIREMENTS_RESOLVER", flag);
    const page = SmartNudgesPage();
    expect(page.type).toBe(SmartNudgesView);
    expect(page.props.requirementsResolverEnabled).toBe(flag === "1");
  });

  it.each(roles)("retains the authenticated route, queue, templates and shared provider for %s", async (role) => {
    auth.mockResolvedValue({ user: { role, email: "synthetic@example.invalid" }, navigationScope: "synthetic", expires: "2026-10-01T00:00:00Z" });
    const workflow = await WorkflowLayout({ children: React.createElement(SmartNudgesPage) });
    expect(workflow.type).toBe(WorkflowProvider);
    const html = renderToStaticMarkup(await AuthenticatedLayout({ children: workflow }));
    const seed = getWorkflowSeed();

    expect(html).toContain("<h1>Smart Nudges</h1>");
    expect(html).toContain("Nudge Queue");
    expect(html).toContain("Template Library");
    expect(seed.nudges.length).toBeGreaterThan(0);
    expect(seed.templates.length).toBeGreaterThan(0);
    for (const value of [...seed.nudges.map((nudge) => nudge.subject), ...seed.templates.map((template) => template.name)]) {
      expect(html).toContain(renderToStaticMarkup(React.createElement(React.Fragment, null, value)));
    }
    expect(html).not.toContain('href="/smart-nudges"');
    expect(html).not.toContain('href="/decision-center"');
    expect(html).toContain('href="/tasks"');
  });

  it("still rejects unauthenticated requests at the existing shell boundary", async () => {
    auth.mockResolvedValue(null);
    await expect(AuthenticatedLayout({ children: React.createElement(SmartNudgesPage) })).rejects.toThrow("redirect:/");
    auth.mockRejectedValue(new Error("synthetic auth unavailable"));
    await expect(AuthenticatedLayout({ children: React.createElement(SmartNudgesPage) })).rejects.toThrow("synthetic auth unavailable");
  });
});
