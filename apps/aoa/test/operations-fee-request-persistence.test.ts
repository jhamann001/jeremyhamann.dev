import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("prisma/migrations/20260903193000_operations_fee_request_intake/migration.sql");
const devClientConstraint = read("prisma/migrations/20260904201500_operations_fee_dev_client_constraint/migration.sql");
const data = read("lib/data/operations-fee-requests.ts");
const action = read("app/(authenticated)/operations/fee-requests/actions.ts");
const auditCoverage = read("test/audit/row-change.integration.test.ts");

describe("Operations fee-request persistence controls", () => {
  it("keeps phase-one requests and events append-only for the application role", () => {
    expect(migration).toContain('GRANT SELECT, INSERT ON "app"."operations_fee_request" TO app_rw');
    expect(migration).toContain('GRANT SELECT, INSERT ON "app"."operations_fee_request_event" TO app_rw');
    expect(migration).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*operations_fee_request/i);
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("limits reads and submissions to Operations/Admin and binds the authenticated identity", () => {
    expect(migration).toContain("IN ('ADMIN', 'OPERATIONS')");
    expect(migration).toContain("current_setting('app.user_email', true)");
    expect(migration).toContain('"submitted_by_email" VARCHAR(320) NOT NULL');
    expect(migration).toContain('"actor_email" VARCHAR(320) NOT NULL');
    expect(migration).toContain('"status" = \'PENDING\'');
    expect(action).toContain("canAccessOperationsTools(role)");
    expect(action).toContain("operationsFeeRequestsPreviewEnabled()");
    expect(data).toContain("submitted_by_email: email");
    expect(data).toContain("submitted_by_role: role");
  });

  it("revalidates every selected client and account inside the scoped write transaction", () => {
    expect(data).toContain("withUserScope({ role, email }");
    expect(data).toContain("WHEN client_sf_id ~ '^[A-Za-z0-9]{15,18}$' THEN upper(left(client_sf_id, 15))");
    expect(data).toContain("ELSE upper(client_sf_id)");
    expect(data).toContain("custodian_account_id IN (${Prisma.join(input.accountIds)})");
    expect(data).toContain('throw new Error("account_unavailable")');
  });

  it("keeps the database client-id constraint aligned with guarded development fixtures", () => {
    expect(devClientConstraint).toContain('"client_sf_id" ~ \'^[[:alnum:]]{15,18}$\'');
    expect(devClientConstraint).toContain('"client_sf_id" ~ \'^DEV-[A-Z0-9]+(-[A-Z0-9]+)*$\'');
    expect(data).toContain('if (!clientSfId) throw new Error("client_unavailable")');
  });

  it("keeps sensitive request content out of generic audit detail and sends no notification", () => {
    const auditDetail = data.match(/const detail = \{([\s\S]*?)\n    \};/)?.[1] ?? "";
    expect(data).toContain("accountCount: input.accountIds.length");
    expect(data).toContain("ticketReferenceCount: input.relevantTicketRefs.length");
    expect(auditDetail).not.toContain("reason: input.reason");
    expect(auditDetail).not.toContain("relevantTicketRefs: input.relevantTicketRefs");
    expect(action).not.toMatch(/slack|webhook|notify/i);
  });

  it("documents why sensitive request tables bypass generic row snapshots", () => {
    expect(auditCoverage).toContain('"operations_fee_request"');
    expect(auditCoverage).toContain('"operations_fee_request_event"');
    expect(auditCoverage).toContain("would duplicate that sensitive payload into audit.row_change");
  });
});
