import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FundingTypeControl } from "@/components/transfers/FundingTypeControl";
import { useOptionalTransferPlanDraft } from "@/components/transfers/TransferPlanDraftProvider";

vi.mock("@/components/transfers/TransferPlanDraftProvider", () => ({
  useOptionalTransferPlanDraft: vi.fn(),
}));

type Draft = NonNullable<ReturnType<typeof useOptionalTransferPlanDraft>>;
const optionalDraft = vi.mocked(useOptionalTransferPlanDraft);

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    fundingType: "DRS",
    setFundingType: vi.fn(),
    basisDecision: (_id, fallback) => fallback,
    setBasisDecision: vi.fn(),
    partialPosition: (_symbol, fallback) => fallback,
    setPartialPosition: vi.fn(),
    canEdit: true,
    canApprove: true,
    approvalMode: "PREPARATION",
    dirty: false,
    pending: false,
    planComplete: false,
    approvedVersion: 0,
    approvedAt: null,
    approvedBy: null,
    errors: [],
    approve: vi.fn(),
    ...overrides,
  };
}

function render(canWrite = true) {
  return renderToStaticMarkup(
    createElement(FundingTypeControl, { fundingType: "DRS", canWrite }),
  );
}

function selectedValues(html: string) {
  return [...html.matchAll(/<option\b([^>]*)>/g)]
    .filter(([, attributes]) => /\bselected=""/.test(attributes))
    .map(([, attributes]) => attributes.match(/\bvalue="([^"]*)"/)?.[1]);
}

describe("FundingTypeControl shared draft selection", () => {
  beforeEach(() => {
    optionalDraft.mockReset();
    optionalDraft.mockReturnValue(draft());
  });

  it("renders the initial DRS draft as the selected option", () => {
    expect(selectedValues(render())).toEqual(["DRS"]);
  });

  it("renders Not chosen when an existing DRS selection is cleared in the draft", () => {
    optionalDraft.mockReturnValue(draft({ fundingType: null, dirty: true }));

    const html = render();

    expect(html).toContain('aria-label="Funding type"');
    expect(selectedValues(html)).toEqual([""]);
    expect(html).toContain("Draft · not approved");
  });

  it("renders a newly chosen draft funding type instead of persisted DRS", () => {
    optionalDraft.mockReturnValue(draft({ fundingType: "WIRE", dirty: true }));

    const html = render();

    expect(selectedValues(html)).toEqual(["WIRE"]);
    expect(html).toContain("Est. 1–2 business days");
  });

  it("falls back to persisted DRS without a draft provider", () => {
    optionalDraft.mockReturnValue(null);

    const html = render();

    expect(html).not.toContain("<select");
    expect(html).toMatch(/>DRS<\/span>/);
    expect(html).not.toContain("Not chosen");
  });

  it.each([
    { canWrite: false, canEdit: true },
    { canWrite: true, canEdit: false },
  ])("preserves a cleared draft in read-only output ($canWrite/$canEdit)", ({ canWrite, canEdit }) => {
    optionalDraft.mockReturnValue(draft({ fundingType: null, canEdit, dirty: true }));

    const html = render(canWrite);

    expect(html).not.toContain("<select");
    expect(html).toContain("Not chosen");
    expect(html).not.toContain("DRS");
  });
});
