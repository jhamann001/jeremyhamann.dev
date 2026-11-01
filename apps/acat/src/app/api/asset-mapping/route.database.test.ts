// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gcp-auth", () => ({ getAuthenticatedClient: async () => ({ request: upstream }) }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "synthetic-ops@example.test", role: "USER" } }) }));
const enabled = process.env.ACAT_SECURITY_DATABASE_TEST === "1";
let recordId: string | undefined;

describe.skipIf(!enabled)("source relinking against PostgreSQL", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !["/acat_security_test", "/transfer_tracker_test"].includes(url.pathname)) {
      throw new Error("Source relinking tests require an explicit localhost test database");
    }
    vi.stubEnv("GCP_ASSET_MAPPING_URL", "https://synthetic-mapping.example.test");
  });
  afterAll(async () => {
    if (recordId) await prisma.acatRecord.delete({ where: { id: recordId } });
    vi.unstubAllEnvs();
  });

  it("persists the selected registration, retires obsolete expectations, and preserves received data", async () => {
    const record = await prisma.acatRecord.create({ data: {
      clientName: "Synthetic Source Test", apexAccountId: "SYNTHETIC", acatDate: "2026-09-16",
      lastUpdated: "2026-09-16T00:00:00Z", statementAccountNumber: null,
      assets: { create: [
        { symbol: "TESTA", description: "Synthetic retained", expectedQty: 10, actualQty: 8, notes: "Retain received note" },
        { symbol: "TESTB", description: "Synthetic retired", expectedQty: 20, actualQty: 18, notes: "Retain mismatch note", includeInTransfer: true },
      ] },
    } });
    recordId = record.id;
    const sourceId = "aab63872-c77f-4791-8000-dd876b012345";
    upstream.mockResolvedValue({ status: 200, data: {
      id: sourceId, account_number: null, account_registration: "Roth IRA", account_holder: "Synthetic Owner",
      investor_number: "INV123456", statement_date: "2026-08-31", is_stale: false,
      positions: [
        { symbol: "TESTA", description: "Synthetic retained", quantity: 5, effective_status: "ACAT", effective_notes: "Source note", transferring: "YES" },
        { symbol: "TESTC", description: "Synthetic new", quantity: 2 },
      ],
    } });
    const request = () => new NextRequest("http://localhost/api/asset-mapping", { method: "POST", body: JSON.stringify({ acatId: record.id, sourceAccountId: sourceId }) });
    const response = await POST(request());
    expect(response.status).toBe(200);
    const saved = await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id }, include: { assets: true } });
    expect(saved.mappingAccountId).toBe(sourceId);
    expect(saved.mappingAccountSummary).toMatchObject({ registration: "Roth IRA", investorNumberLast4: "3456" });
    expect(saved.assets.find((a) => a.symbol === "TESTA")).toMatchObject({ expectedQty: 5, actualQty: 8, notes: "Retain received note", mappingTransferStatus: "ACAT" });
    expect(saved.assets.find((a) => a.symbol === "TESTB")).toMatchObject({ expectedQty: 0, actualQty: 18, includeInTransfer: true, notes: "Retain mismatch note" });
    expect(saved.assets.find((a) => a.symbol === "TESTC")).toMatchObject({ expectedQty: 2, actualQty: 0 });
    upstream.mockRejectedValue({ response: { status: 409 } });
    expect((await POST(request())).status).toBe(409);
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id }, include: { assets: true } })).toEqual(saved);
    upstream.mockResolvedValue({ status: 200, data: {
      id: sourceId, account_number: null, account_registration: "Roth IRA",
      positions: [{ symbol: "TESTB", description: "Synthetic returned", quantity: 20 }],
    } });
    expect((await POST(request())).status).toBe(200);
    const returned = await prisma.asset.findFirstOrThrow({ where: { acatRecordId: record.id, symbol: "TESTB" } });
    expect(returned).toMatchObject({ expectedQty: 20, actualQty: 18, includeInTransfer: true, notes: "Retain mismatch note" });
  });
});
