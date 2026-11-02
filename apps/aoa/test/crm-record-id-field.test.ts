import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CRM_ID_MASK, CrmIdField } from "@/components/crm/CrmIdField";
import { CRM_ID_VIEW_ROLES, canViewCrmId } from "@/lib/crm/visibility";

describe("CRM record ID visibility", () => {
  it("permits only Admin and Operations to receive record IDs", () => {
    expect([...CRM_ID_VIEW_ROLES].sort()).toEqual(["ADMIN", "OPERATIONS"]);
    for (const role of ["ADMIN", "OPERATIONS"]) {
      expect(canViewCrmId(role)).toBe(true);
    }
    for (const role of [
      "HEAD_OF_ADVISORY",
      "ADVISOR",
      "CLIENT_SERVICE",
      "VIEWER",
      "",
      null,
      undefined,
    ]) {
      expect(canViewCrmId(role)).toBe(false);
    }
  });

  it("renders a fixed mask by default with explicit reveal, copy, and Explorer controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(CrmIdField, { value: "hld_example123" }),
    );

    expect(CRM_ID_MASK).toBe("••••••••");
    expect(html).toContain(`<code class="`);
    expect(html).toContain(CRM_ID_MASK);
    expect(html).toContain("Show CRM ID");
    expect(html).toContain("Copy CRM ID");
    expect(html).toContain('href="/crm/hld_example123"');
    expect(html).toContain("Open in Explorer");
  });
});
