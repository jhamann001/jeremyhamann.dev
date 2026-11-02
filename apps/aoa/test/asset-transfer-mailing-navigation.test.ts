// @vitest-environment jsdom
import { createElement, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn(() => { throw new Error("Unexpected database read"); }) }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/asset-transfer/T1" }));
vi.mock("next/link", () => ({
  default: ({ children, onClick, prefetch: _prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement("a", {
    ...props,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => { onClick?.(event); event.preventDefault(); },
  }, children),
}));

import { MailingReport } from "@/components/asset-transfer/views/MailingReport";
import { ListBackLink } from "@/components/navigation/ListBackLink";
import { getBrowserListNavigationMemory } from "@/lib/navigation/list-memory";
import type { MailingReportRow } from "@/lib/transfers/mailing";

const SCOPE = "synthetic-navigation-scope";
const HREF = "/reporting/mailing?carrier=FedEx&mailedFrom=2026-10-01&mailedThrough=2026-10-31&mailingStatus=in-transit&q=Synthetic";
const FILTERS = { query: "Synthetic", from: "2026-10-01", through: "2026-10-31", status: "in-transit" as const, carrier: "FedEx" as const };
const MAILING: MailingReportRow = {
  id: "mail-1", transferId: "T1", href: "/asset-transfer/T1", recordedAt: "2026-10-14", client: "Synthetic Client",
  sourceAccount: "Synthetic Brokerage · Individual · ••1234", receivingAccount: "Individual", reason: "Signature needed",
  contents: "Transfer form", journey: "Cedar Ridge to the client", postage: "$9.10", status: "In transit to the client",
  legs: [{ number: 1, label: "Cedar Ridge → the client", from: "CedarRidge", to: "the client", carrier: "FedEx",
    trackingNumber: "SYN-TRACK", mailedOn: "2026-10-14", receivedOn: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getBrowserListNavigationMemory()?.setScope(null);
  getBrowserListNavigationMemory()?.setScope(SCOPE);
});
afterEach(() => { cleanup(); getBrowserListNavigationMemory()?.setScope(null); });

describe("mailing report navigation", () => {
  it("submits all report filters to Reporting without the obsolete view parameter", () => {
    const view = render(createElement(MailingReport, { rows: [MAILING], transfers: [], filters: FILTERS, scope: SCOPE, listHref: HREF }));
    const form = view.container.querySelector("form")!;
    expect(form.getAttribute("action")).toBe("/reporting/mailing");
    expect(form.querySelector('[name="view"]')).toBeNull();
    fireEvent.submit(form);
    expect(router.push).toHaveBeenCalledWith(HREF, { scroll: false });
    expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/reporting/mailing");
  });

  it("keeps the exact filtered report on transfer return and discards it for a different scope", () => {
    const report = render(createElement(MailingReport, { rows: [MAILING], transfers: [], filters: FILTERS, scope: SCOPE, listHref: HREF }));
    const open = screen.getByRole("link", { name: "View transfer →" });
    expect(open.getAttribute("href")).toBe("/asset-transfer/T1?from=mailing");
    fireEvent.click(open);
    report.unmount();
    const backProps = { scope: SCOPE, detailHref: "/asset-transfer/T1", fallback: "/reporting/mailing", children: "Back to mailing report" };
    const detail = render(createElement(ListBackLink, backProps));
    const back = screen.getByRole("link", { name: "Back to mailing report" });
    expect(back.getAttribute("href")).toBe(HREF);
    fireEvent.click(back);
    expect(router.replace).toHaveBeenCalledWith(HREF, { scroll: false });
    getBrowserListNavigationMemory()?.setScope("another-authenticated-scope");
    detail.rerender(createElement(ListBackLink, { ...backProps, scope: "another-authenticated-scope" }));
    expect(screen.getByRole("link", { name: "Back to mailing report" }).getAttribute("href")).toBe("/reporting/mailing");
  });
});
