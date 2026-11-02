// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@/app/(authenticated)/client-portrait/[id]/actions", () => ({
  previewLinkedHoldings: actions.preview,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/client-portrait/synthetic",
}));

import { AccountsSection } from "@/components/client-portrait/AccountsSection";
import type { ClientAccounts, ExternalAccount } from "@/lib/data/types";

function liveExt(extra: Partial<ExternalAccount> = {}): ExternalAccount {
  return {
    inst: "Invented Bank", type: "brokerage", num: "••••2222", balance: 1500.25,
    externalAccountId: "ext-synthetic-1", cash: 500.25, securities: 1000,
    holdingsTotal: 1500.25, asOf: "2026-10-01T00:00:00.000Z", institutionBalance: 1499,
    ...extra,
  };
}

const LIVE: ClientAccounts = {
  apex: [], investment: [], bene: [], plaidLinked: true, plaidSummariesLive: true,
  ext: [liveExt(), liveExt({ externalAccountId: "ext-synthetic-2", inst: "Other Bank", num: "••••3333" })],
};

function setup(props: { canPreviewHoldings?: boolean; clientSfId?: string; accounts?: ClientAccounts } = {}) {
  return render(createElement(AccountsSection, {
    clientName: "Invented Person",
    accounts: props.accounts ?? LIVE,
    clientSfId: "clientSfId" in props ? props.clientSfId : "003-synthetic",
    canPreviewHoldings: props.canPreviewHoldings,
  }));
}

const summaryTable = () => screen.getByRole("table", { name: "Plaid-linked account summaries" });

beforeEach(() => actions.preview.mockReset());
afterEach(cleanup);

describe("ticket holdings preview control", () => {
  it.each([undefined, false])("canPreviewHoldings=%s renders no control, no column and no call", (canPreviewHoldings) => {
    setup({ canPreviewHoldings });
    expect(screen.queryByRole("button", { name: /preview holdings/i })).toBeNull();
    expect(within(summaryTable()).queryByRole("columnheader", { name: "Holdings" })).toBeNull();
    expect(actions.preview).not.toHaveBeenCalled();
  });

  it("renders no control without a client id even when allowed", () => {
    setup({ canPreviewHoldings: true, clientSfId: undefined });
    expect(screen.queryByRole("button", { name: /preview holdings/i })).toBeNull();
  });

  it("renders no control on mock rows when summaries are off", () => {
    setup({
      canPreviewHoldings: true,
      accounts: { ...LIVE, plaidSummariesLive: false, ext: [{ inst: "Mercury", type: "Checking", num: "••••4004", balance: 96000 }] },
    });
    expect(screen.queryByRole("button", { name: /preview holdings/i })).toBeNull();
  });

  it("renders one control per live row and no call until clicked", () => {
    setup({ canPreviewHoldings: true });
    expect(screen.getAllByRole("button", { name: "Preview holdings" })).toHaveLength(2);
    expect(within(summaryTable()).getByRole("columnheader", { name: "Holdings" })).toBeTruthy();
    expect(actions.preview).not.toHaveBeenCalled();
  });

  it("shows holdings sum, institution balance, difference and as-of in page memory on success", async () => {
    actions.preview.mockResolvedValue({
      ok: true, asOf: "2026-10-02T00:00:00Z", holdingsTotal: 1500.25, institutionBalance: 1499, difference: 1.25,
      rows: [
        { symbol: "VTI", name: "Vanguard Total", quantity: 10.5, value: 1000, label: "likely_transferable", reason: "standard_security" },
        { symbol: "sec-cash", name: "Cash", quantity: null, value: 500.25, label: "unknown", reason: "CUSIP037833100" },
      ],
    });
    setup({ canPreviewHoldings: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Preview holdings" })[0]);

    const panel = await screen.findByRole("region", { name: "Holdings preview for Invented Bank ••••2222" });
    expect(actions.preview).toHaveBeenCalledWith({ clientSfId: "003-synthetic", externalAccountId: "ext-synthetic-1" });
    expect(panel.textContent).toContain("Holdings sum $1,500.25");
    expect(panel.textContent).toContain("Institution balance $1,499.00");
    expect(panel.textContent).toContain("Difference $1.25");
    expect(panel.textContent).toContain("As-of 2026-10-02");
    expect(within(panel).getByText("VTI")).toBeTruthy();
    expect(within(panel).getByText("Vanguard Total")).toBeTruthy();
    expect(within(panel).getByText("Likely transferable")).toBeTruthy();
    expect(within(panel).getByText("Standard security")).toBeTruthy();
    expect(within(panel).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(panel.textContent).not.toContain("CUSIP037833100");
    expect(panel.textContent).toContain("not saved in AoA");
    expect(screen.queryByRole("region", { name: /Holdings preview for Other Bank/ })).toBeNull();
  });

  it("keeps the account summary and states the preview failed on failure", async () => {
    actions.preview.mockResolvedValue({ ok: false, reason: "preview_failed" });
    setup({ canPreviewHoldings: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Preview holdings" })[1]);

    await screen.findByText(/Preview failed/);
    const table = summaryTable();
    expect(within(table).getByText("Other Bank")).toBeTruthy();
    expect(within(table).getAllByText("$1,500.25").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: /Holdings preview for/ })).toBeNull();
  });

  it("treats a rejected action as a failed preview", async () => {
    actions.preview.mockRejectedValueOnce(new Error("network"));
    setup({ canPreviewHoldings: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Preview holdings" })[0]);
    await waitFor(() => expect(screen.getByText(/Preview failed/)).toBeTruthy());
  });
});

describe("ticket server-side wiring", () => {
  it("page decides the control on the server from the switch and role gate", () => {
    const page = readFileSync("app/(authenticated)/client-portrait/[id]/page.tsx", "utf8");
    expect(page).toContain("canPreviewHoldings={plaidHoldingsPreviewAllowed(identity.role)}");
    expect(page).toContain("clientSfId={client.sf_id}");
  });

  it("the client component never reads flags or environment", () => {
    const component = readFileSync("components/client-portrait/AccountsSection.tsx", "utf8");
    expect(component).not.toMatch(/process\.env|@\/lib\/flags|allowPlaidHoldingsPreviewEnabled|@\/lib\/warehouse/);
  });
});
