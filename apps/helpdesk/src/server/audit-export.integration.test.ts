/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB, the
 * immutability triggers make fixture rows permanent). Proves the export-snapshot fix (Decision #54, finding
 * AUD-2): the row count recorded as AUDIT_LOG_EXPORTED.newValue equals the number of rows the CSV carries,
 * and the export's own row is NOT in its own file (it is bounded out by `toSeq`, read before it is written).
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the compliance-only route runs against the real
 * test database with a fixed viewer/context.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_export_user_${RUN}`;
const EXPORTER_EMAIL = `compliance.export.${RUN}@wm-helpdesk.local`;
const SEEDED_ROWS = 4;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));
hoisted.viewer = { id: USER_ID, email: EXPORTER_EMAIL, name: "Cora Export", image: null, groups: ["compliance_officers"], isDev: false };
hoisted.ctx = { ipAddress: "203.0.113.11", userAgent: `it-export/${RUN}`, requestId: `it-export-${RUN}`, isPrefetch: false };

vi.mock("@/lib/session", () => ({
  requireViewerOrThrow: vi.fn(async () => hoisted.viewer),
  getViewer: vi.fn(async () => hoisted.viewer),
  requireUser: vi.fn(async () => hoisted.viewer),
  requireGroup: vi.fn(async () => hoisted.viewer),
}));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: vi.fn(async () => hoisted.ctx),
  getRequestContextFromRequest: vi.fn(() => hoisted.ctx),
}));

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;
const routeModule = TEST_URL ? await import("@/app/api/compliance/audit/export/route") : null;

function mods() {
  if (!dbModule || !auditModule || !routeModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...auditModule, GET: routeModule.GET };
}

describe.skipIf(!TEST_URL)("audit export snapshot (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma, writeAudit } = mods();
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { groups: ["compliance_officers"], isActive: true },
      create: {
        id: USER_ID,
        email: EXPORTER_EMAIL,
        name: "Cora Export",
        groups: ["compliance_officers"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    // Seed exactly SEEDED_ROWS rows attributable to this run's unique exporter email.
    for (let i = 0; i < SEEDED_ROWS; i++) {
      await writeAudit(prisma, { id: USER_ID, email: EXPORTER_EMAIL, groups: ["compliance_officers"] }, hoisted.ctx, {
        action: "AUDIT_LOG_VIEWED",
        entityType: "AUDIT_LOG",
        metadata: { filters: { seedIndex: i } },
      });
    }
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("newValue equals the CSV row count, and the export's own row is excluded from its own file (Decision #54)", async () => {
    const { GET, prisma } = mods();
    const url = `http://localhost/api/compliance/audit/export?actorEmail=${encodeURIComponent(EXPORTER_EMAIL)}`;
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    const text = await res.text();

    const lines = text.split("\r\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const dataRows = lines.length - 1; // minus the header line
    expect(dataRows).toBe(SEEDED_ROWS);

    // The AUDIT_LOG_EXPORTED row (written before the stream, seq > toSeq) is NOT in the file it counts.
    expect(text).not.toContain("AUDIT_LOG_EXPORTED");
    expect((text.match(/AUDIT_LOG_VIEWED/g) ?? []).length).toBe(SEEDED_ROWS);

    // The recorded total equals what the file carries.
    const exportRow = await prisma.auditLog.findFirst({
      where: { action: "AUDIT_LOG_EXPORTED", actorEmail: EXPORTER_EMAIL },
      orderBy: { seq: "desc" },
    });
    expect(exportRow).not.toBeNull();
    expect(exportRow!.newValue).toBe(String(dataRows));
    expect(exportRow!.newValue).toBe(String(SEEDED_ROWS));
    // The snapshot bound is recorded, and the export row itself sits above it.
    const meta = exportRow!.metadata as { toSeq?: string } | null;
    expect(meta?.toSeq).toBeTypeOf("string");
    expect(exportRow!.seq).toBeGreaterThan(BigInt(meta!.toSeq!));
  });
});
