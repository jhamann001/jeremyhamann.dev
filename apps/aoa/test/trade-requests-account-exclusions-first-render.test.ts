import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/app/(authenticated)/trade-requests/new/actions", () => ({
  loadAccountExclusions: vi.fn(),
  loadClientExclusions: vi.fn(),
  applyExclusionBatch: vi.fn(),
}));
vi.mock("@/components/trade-requests/form/NewRequestDraft", () => ({ useNewRequestDraft: () => state.value }));

import { AccountExclusionsPanel } from "@/components/trade-requests/form/exclusions/AccountExclusionsPanel";
import { clientsById, initialNewRequestDraft, type NewRequestClient } from "@/lib/trade-requests/new-request";

// ticket: the panel's first render, before any read has started (for
// example, returning to the form with accounts already selected). Synthetic data.

const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [{ id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1_500 }] },
];

function firstRender(selectedAccounts: string[]) {
  const draft = { ...initialNewRequestDraft(), clientIds: ["c-alex"], selectedAccounts };
  state.value = { draft, context: { draft, clientsById: clientsById(CLIENTS) } };
  return renderToStaticMarkup(createElement(AccountExclusionsPanel));
}

describe("account exclusions panel first render", () => {
  it("shows loading, not the empty message, when accounts are already selected", () => {
    const html = firstRender(["SYN00001"]);
    expect(html).toContain("Loading account exclusions...");
    expect(html).not.toContain("No account-specific exclusions on selected accounts.");
  });

  it("shows the empty message when no account is selected", () => {
    const html = firstRender([]);
    expect(html).toContain("No account-specific exclusions on selected accounts.");
    expect(html).not.toContain("Loading account exclusions...");
  });
});
