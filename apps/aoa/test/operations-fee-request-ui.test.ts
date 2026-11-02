import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const hub = read("app/(authenticated)/operations/page.tsx");
const route = read("app/(authenticated)/operations/fee-requests/page.tsx");
const form = read("components/operations/FeeRequestIntake.tsx");
const workflow = read("components/operations/FeeRequestWorkflow.tsx");
const card = read("components/operations/FeeRequestCard.tsx");
const workspace = read("components/operations/FeeRequestWorkspace.tsx");

describe("Operations fee-request intake UI", () => {
  it("is reachable from the dev hub and repeats the direct-route boundary", () => {
    expect(hub).toContain('href="/operations/fee-requests"');
    expect(hub).toContain("operationsFeeRequestsPreviewEnabled()");
    expect(route).toContain("operationsFeeRequestsPreviewEnabled()");
    expect(route).toContain("canAccessOperationsTools(role)");
    expect(route).toContain('href="/api/operations/fee-requests/export?area=credits"');
    expect(route).toContain('href="/api/operations/fee-requests/export?area=exceptions"');
  });

  it("captures the real Fee Store request inputs without self-selected requester identity", () => {
    for (const label of [
      "Client",
      "Fee type",
      "Requested credit amount",
      "Waiver start",
      "Duration in months",
      "Indefinite duration",
      "Accounts where this request applies",
      "Reason for waiver",
      "Relevant Zendesk or CRM tickets",
    ]) expect(form).toContain(label);
    expect(form).not.toContain("Your Role");
    expect(route).toContain("authenticated user is recorded automatically");
  });

  it("states the workflow boundary without hiding the available review actions", () => {
    expect(route).toContain("AOA records the request and review workflow");
    expect(route).toContain("authorized Operations and Admin users can approve, reject, cancel, or record a completed credit here");
    expect(route).toContain("does not calculate an advisory fee, move money, or alter billing");
    expect(route).toContain("Slack notifications are disabled in development");
    expect(form).toContain("Slack notifications are disabled in development");
    expect(form).toContain("Submitting creates a pending review");
    expect(form).toContain("AOA does not calculate it");
    expect(form).not.toMatch(/fetch\(|axios|webhook/i);
  });

  it("keeps new requests pending until the separate review workflow acts", () => {
    expect(form).not.toMatch(/name=["'](?:status|approval_status|reviewed_by_email|workflowAction)["']/);
    expect(workspace).toContain('<StatTile label="Pending" value={counts.pending} />');
    expect(workflow).toContain('request.status === "PENDING"');
    expect(workflow).toContain('action="APPROVE"');
    expect(workflow).toContain('action="REJECT"');
    expect(workflow).toContain('action="CANCEL"');
  });

  it("renders the complete submitted request when a recent request is expanded", () => {
    expect(card).toContain("Submitted request");
    expect(card).toContain("The complete request as it was recorded in AOA");
    for (const label of [
      "Request type",
      "Requested credit amount",
      "Waiver start",
      "Duration",
      "Client",
      "Submitted by",
      "Accounts",
      "Reason or context",
      "Relevant tickets",
      "Request ID",
    ]) expect(card).toContain(label);
    expect(card).toContain('request.feeTypes.join(", ")');
    expect(card).toContain("request.indefiniteDuration");
    expect(card).toContain('request.scope === "HOUSEHOLD"');
    expect(card).toContain("Canonical contact:");
    expect(card).toContain("account.ownerName");
  });
});
