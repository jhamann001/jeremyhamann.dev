// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/(authenticated)/client-portrait/[id]/actions", () => ({
  previewLinkedHoldings: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/client-portrait/synthetic",
}));

import { previewLinkedHoldings } from "@/app/(authenticated)/client-portrait/[id]/actions";
import { AccountsSection } from "@/components/client-portrait/AccountsSection";
import { usdCompact } from "@/lib/format";
import { accountsByClient } from "@/lib/mock/client-portrait";
import type { ClientAccounts, ExternalAccount } from "@/lib/data/types";

// ticket: Accounts card behaviour across the summaries/preview switches as the
// page passes them in (plaidSummariesLive from the mirror read, canPreviewHoldings
// from the server-side role gate). Freshness is shown, never hidden.

function liveRow(extra: Partial<ExternalAccount> = {}): ExternalAccount {
  return {
    inst: "Test Bank", type: "Brokerage", num: "••••1234", balance: 100,
    externalAccountId: "ext-1", cash: 10, securities: 90, holdingsTotal: 100,
    institutionBalance: 100, asOf: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

const baseAccounts: ClientAccounts = {
  apex: [],
  investment: [],
  ext: [liveRow()],
  bene: [],
  plaidLinked: true,
  plaidSummariesLive: true,
};

function renderSection(accounts: ClientAccounts, canPreviewHoldings: boolean) {
  return render(createElement(AccountsSection, {
    accounts,
    clientName: "Ada Client",
    clientSfId: "003TEST",
    canPreviewHoldings,
  }));
}

const summaryTable = () => screen.getByRole("table", { name: "Plaid-linked account summaries" });
const previewButtons = () => screen.queryAllByRole("button", { name: "Preview holdings" });

beforeEach(() => vi.mocked(previewLinkedHoldings).mockReset());
afterEach(() => cleanup());

describe("AccountsSection preview prop", () => {
  it("hides Preview holdings when canPreviewHoldings is false", () => {
    renderSection(baseAccounts, false);
    expect(screen.queryByText("Preview holdings")).toBeNull();
  });

  it("shows Preview holdings when canPreviewHoldings is true", () => {
    renderSection(baseAccounts, true);
    expect(screen.getByText("Preview holdings")).toBeTruthy();
  });

  it("shows Preview failed when the action catch returns preview_failed", async () => {
    vi.mocked(previewLinkedHoldings).mockResolvedValue({ ok: false, reason: "preview_failed" });
    renderSection(baseAccounts, true);
    fireEvent.click(screen.getByText("Preview holdings"));
    expect(await screen.findByText(/Preview failed/)).toBeTruthy();
    const row = within(summaryTable()).getByText("Test Bank").closest("tr")!;
    expect(row.textContent).toContain("$100.00");
    expect(row.textContent).toContain("2026-10-01");
    expect(screen.queryByRole("region", { name: /Holdings preview for/ })).toBeNull();
  });

  it("a retry after a failed preview replaces the failure with the result", async () => {
    vi.mocked(previewLinkedHoldings)
      .mockResolvedValueOnce({ ok: false, reason: "preview_failed" })
      .mockResolvedValueOnce({
        ok: true, asOf: "2026-10-02", holdingsTotal: 100, institutionBalance: 100, difference: 0,
        rows: [{ symbol: "VTI", name: "Vanguard Total", quantity: 1, value: 100 }],
      });
    renderSection(baseAccounts, true);
    fireEvent.click(screen.getByText("Preview holdings"));
    await screen.findByText(/Preview failed/);
    fireEvent.click(screen.getByText("Preview holdings"));
    expect(await screen.findByRole("region", { name: "Holdings preview for Test Bank ••••1234" })).toBeTruthy();
    expect(screen.queryByText(/Preview failed/)).toBeNull();
  });
});

describe("AccountsSection freshness display", () => {
  it("shows each summary row's as-of, including a stale one, and a dash when unknown", () => {
    renderSection({
      ...baseAccounts,
      ext: [
        liveRow(),
        liveRow({ externalAccountId: "ext-stale", inst: "Stale Bank", num: "••••5555", asOf: "2025-01-15T00:00:00.000Z" }),
        liveRow({ externalAccountId: "ext-unknown", inst: "Unknown Bank", num: "••••7777", asOf: null }),
      ],
    }, false);
    const table = summaryTable();
    expect(within(table).getByRole("columnheader", { name: "As-of" })).toBeTruthy();
    const rowFor = (inst: string) => within(table).getByText(inst).closest("tr")!;
    expect(rowFor("Test Bank").textContent).toContain("2026-10-01");
    expect(rowFor("Stale Bank").textContent).toContain("2025-01-15");
    expect(within(rowFor("Unknown Bank")).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows the preview payload's as-of on success, and a dash when the card has none", async () => {
    vi.mocked(previewLinkedHoldings)
      .mockResolvedValueOnce({
        ok: true, asOf: "2026-10-02T15:00:00Z", holdingsTotal: 100, institutionBalance: 100, difference: 0,
        rows: [],
      })
      .mockResolvedValueOnce({
        ok: true, asOf: null, holdingsTotal: 50, institutionBalance: 50, difference: 0, rows: [],
      });
    renderSection({
      ...baseAccounts,
      ext: [liveRow(), liveRow({ externalAccountId: "ext-2", inst: "Other Bank", num: "••••9999" })],
    }, true);

    fireEvent.click(previewButtons()[0]);
    const first = await screen.findByRole("region", { name: "Holdings preview for Test Bank ••••1234" });
    expect(first.textContent).toContain("As-of 2026-10-02");

    fireEvent.click(previewButtons()[1]);
    const second = await screen.findByRole("region", { name: "Holdings preview for Other Bank ••••9999" });
    expect(second.textContent).toContain("As-of —");
  });
});

describe("AccountsSection with summaries and preview switches unset", () => {
  const legacy = accountsByClient["C-1"];

  it.each([false, true])(
    "keeps the legacy mock Plaid table and no preview control (canPreviewHoldings=%s)",
    (canPreviewHoldings) => {
      expect(legacy.plaidSummariesLive).toBeUndefined();
      expect(legacy.plaidLinked).toBe(true);
      renderSection(legacy, canPreviewHoldings);

      expect(screen.queryByRole("table", { name: "Plaid-linked account summaries" })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "As-of" })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "Holdings" })).toBeNull();
      expect(previewButtons()).toHaveLength(0);
      expect(screen.getByRole("columnheader", { name: "Balance" })).toBeTruthy();
      for (const account of legacy.ext) {
        const row = screen.getByText(account.inst).closest("tr")!;
        expect(row.textContent).toContain(usdCompact(account.balance));
      }
      expect(screen.getAllByLabelText("Preview · sample data").length).toBeGreaterThan(0);
      expect(previewLinkedHoldings).not.toHaveBeenCalled();
    },
  );

  it("keeps the not-linked stub when the mock client has no Plaid link", () => {
    renderSection({ ...legacy, ext: [], plaidLinked: false }, true);
    expect(screen.getByText("not linked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link via Plaid" })).toBeTruthy();
    expect(previewButtons()).toHaveLength(0);
  });
});
