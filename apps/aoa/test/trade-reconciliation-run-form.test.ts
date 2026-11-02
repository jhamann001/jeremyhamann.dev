import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { formStatusSpy, runSpy } = vi.hoisted(() => ({
  formStatusSpy: vi.fn(),
  runSpy: vi.fn(),
}));

vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  useFormStatus: formStatusSpy,
}));
vi.mock("@/app/(authenticated)/operations/trade-reconciliation/actions", () => ({
  runTradeReconciliation: runSpy,
}));

import { RunReconciliationForm } from "@/app/(authenticated)/operations/trade-reconciliation/RunReconciliationForm";

function renderForm(initialRunDate = "2026-09-17") {
  const html = renderToStaticMarkup(createElement(RunReconciliationForm, {
    initialRunDate,
    maximumRunDate: "2026-09-17",
  }));
  const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0];
  expect(button).toBeDefined();
  return { html, button: button! };
}

describe("Trade Reconciliation run submission feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formStatusSpy.mockReturnValue({ pending: false });
  });

  it("keeps a valid idle form enabled without querying sources", () => {
    const { html, button } = renderForm();

    expect(button).toContain('type="submit"');
    expect(button).toContain('aria-busy="false"');
    expect(button).toContain('aria-label="Run reconciliation"');
    expect(button).toContain("Run reconciliation");
    expect(button).not.toContain("disabled");
    expect(button).not.toContain('aria-hidden="true"');
    expect(html).toContain('name="runDate"');
    expect(html).toContain('required=""');
    expect(html).toContain('max="2026-09-17"');
    expect(html).toContain("2026-09-16");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("disables submission and exposes a busy status with a decorative spinner while pending", () => {
    formStatusSpy.mockReturnValue({ pending: true });
    const { html, button } = renderForm();

    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('aria-label="Running reconciliation…"');
    expect(button).toContain('aria-hidden="true"');
    expect(button).not.toContain('role="status"');
    expect(html).toMatch(/<\/button><span[^>]*role="status"[^>]*>Reconciliation is running\.<\/span>/);
    expect(button).toContain("Running reconciliation…");
    expect(button).not.toContain(">Run reconciliation<");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it.each(["", "2026-09-13", "2026-09-18", "not-a-date"])(
    "keeps the existing invalid-date restriction while idle: %s",
    (runDate) => {
      const { button } = renderForm(runDate);

      expect(button).toContain('disabled=""');
      expect(button).toContain('aria-busy="false"');
      expect(button).toContain("Run reconciliation");
      expect(button).not.toContain('aria-hidden="true"');
      expect(runSpy).not.toHaveBeenCalled();
    },
  );
});
