// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { POST as importMapping } from "@/app/api/asset-mapping/route";
import { GET as readChoices, PUT as saveChoices } from "../paperwork-assets/route";
import { POST as generate } from "../manual-form-recommendation/route";
import { GET as history } from "./route";
import { GET as download } from "./[documentId]/route";
import { parseAssetMappingCsv } from "@/lib/parse-asset-mapping-csv";

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "synthetic-ops@example.test", role: "USER" } }) }));
const enabled = process.env.ACAT_DOCUMENT_DATABASE_TEST === "1";
const ids: string[] = [];
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (path: string, body?: unknown, method = "POST") => new NextRequest(`http://localhost${path}`, body ? { method, body: JSON.stringify(body) } : undefined);
const recordData = {
  clientName: "Synthetic Document History", apexAccountId: "SYNTHETIC",
  accountType: "Traditional IRA", type: "Partial", transferWorkflow: "MANUAL" as const,
  acatDate: "2026-09-21", lastUpdated: "2026-09-21T00:00:00Z",
  statementAccountNumber: "SYNTH-12345678", transferringContra: "Charles Schwab", dtccNumber: "0164",
};

describe.skipIf(!enabled)("document history against PostgreSQL", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/transfer_tracker_test") {
      throw new Error("Document tests require an explicit localhost transfer_tracker_test database");
    }
  });
  afterAll(async () => {
    // Only records created by this suite; never truncate shared tables.
    for (const id of ids) await prisma.acatRecord.deleteMany({ where: { id } });
  });

  it("remembers 78 selections and retains each exact PDF with its own frozen CSV after edits", async () => {
    const record = await prisma.acatRecord.create({ data: recordData }); ids.push(record.id);
    const other = await prisma.acatRecord.create({ data: { ...recordData, clientName: "Synthetic Other Transfer" } }); ids.push(other.id);
    const positions = Array.from({ length: 78 }, (_, index) => ({
      symbol: `TEST${String(index + 1).padStart(3, "0")}`, description: `Synthetic Security ${index + 1}`,
      qty: index + 1, amount: (index + 1) * 100, assetClass: "Equity", includeInTransfer: index < 70,
    }));
    const upload = await importMapping(request("/api/asset-mapping", {
      acatId: record.id, source: "spreadsheet", sourceAccountNumber: recordData.statementAccountNumber,
      filename: "synthetic-78-holdings.csv", positions,
    }));
    expect(upload.status, await upload.clone().text()).toBe(200);
    const originalMapping = await prisma.acatDocument.findFirstOrThrow({ where: { acatRecordId: record.id } });
    expect(originalMapping).toMatchObject({ kind: "MAPPING_CSV", positionCount: 78, includedCount: 70, excludedCount: 8 });
    expect(Buffer.from(originalMapping.content).toString("utf8")).toBe(originalMapping.inputCsv);
    const reopened = await readChoices(request("/choices"), context(record.id));
    const { assets } = await reopened.json();
    expect(assets).toHaveLength(78);
    expect(assets.filter((asset: { includeInTransfer: boolean }) => asset.includeInTransfer)).toHaveLength(70);

    const generateRequest = () => request("/generate", { apexAccountTitle: "Synthetic Title", apexAccountTitleVerified: true });
    const first = await generate(generateRequest(), context(record.id));
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const firstId = first.headers.get("X-Transfer-Document-Id")!;
    const pdf = await PDFDocument.load(firstBytes);
    expect(pdf.getForm().getTextField("ASSETS DESCRIPTIONSYMBOLRow1").getText()).toBe("See attached list");
    expect(pdf.getPageCount()).toBeGreaterThan(2);

    const middle = assets.find((asset: { symbol: string }) => asset.symbol === "TEST036");
    expect((await saveChoices(request("/choices", { assets: [{ id: middle.id, includeInTransfer: false }] }, "PUT"), context(record.id))).status).toBe(200);
    const second = await generate(generateRequest(), context(record.id));
    expect(second.status).toBe(200);
    const secondId = second.headers.get("X-Transfer-Document-Id")!;
    expect(secondId).not.toBe(firstId);
    const savedSecond = await prisma.acatDocument.findUniqueOrThrow({ where: { id: secondId } });
    expect(savedSecond).toMatchObject({ includedCount: 69, excludedCount: 9 });
    expect(Buffer.from(savedSecond.content)).toEqual(Buffer.from(await second.arrayBuffer()));

    const firstContext = { params: Promise.resolve({ id: record.id, documentId: firstId }) };
    const redownload = await download(request("/download"), firstContext);
    expect(Buffer.from(await redownload.arrayBuffer())).toEqual(firstBytes);
    const oldInputs = parseAssetMappingCsv(await (await download(request("/download?input=1"), firstContext)).text(), recordData.statementAccountNumber);
    expect(oldInputs.positions).toHaveLength(78);
    expect(oldInputs.positions.find((asset) => asset.symbol === "TEST036")).toMatchObject({ includeInTransfer: true, qty: 36, amount: 3600, assetClass: "Equity" });
    const newInputs = parseAssetMappingCsv(savedSecond.inputCsv, recordData.statementAccountNumber);
    expect(newInputs.positions.find((asset) => asset.symbol === "TEST036")?.includeInTransfer).toBe(false);
    const listing = await (await history(request("/history"), context(record.id))).json();
    expect(listing.documents).toHaveLength(3);
    expect(listing.documents.every((doc: object) => !Object.hasOwn(doc, "content") && !Object.hasOwn(doc, "inputCsv"))).toBe(true);
    expect((await download(request("/download"), { params: Promise.resolve({ id: other.id, documentId: firstId }) })).status).toBe(404);

    await prisma.acatRecord.update({ where: { id: record.id }, data: { deletedAt: new Date() } });
    expect((await history(request("/history"), context(record.id))).status).toBe(404);
    expect((await download(request("/download"), firstContext)).status).toBe(404);
    expect(await prisma.acatDocument.count({ where: { acatRecordId: record.id } })).toBe(3);
  }, 30_000);

  it("rolls back holdings when saving their mapping document fails", async () => {
    const record = await prisma.acatRecord.create({ data: { ...recordData, assets: { create: { symbol: "TEST", description: "Before", expectedQty: 1, includeInTransfer: true } } } }); ids.push(record.id);
    // Constrain just this synthetic record's documents to exercise a real
    // database write failure after holdings are updated in the transaction.
    await prisma.$executeRawUnsafe(`ALTER TABLE "AcatDocument" ADD CONSTRAINT "synthetic_history_failure" CHECK ("acatRecordId" <> '${record.id}')`);
    try {
      const failed = await importMapping(request("/api/asset-mapping", {
        acatId: record.id, source: "spreadsheet", sourceAccountNumber: recordData.statementAccountNumber,
        positions: [{ symbol: "TEST", description: "After", qty: 99, includeInTransfer: false }],
      }));
      expect(failed.status).toBe(500);
      const asset = await prisma.asset.findFirstOrThrow({ where: { acatRecordId: record.id } });
      expect(asset).toMatchObject({ description: "Before", expectedQty: 1, includeInTransfer: true });
      expect(await prisma.acatDocument.count({ where: { acatRecordId: record.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "AcatDocument" DROP CONSTRAINT "synthetic_history_failure"');
    }
  });
});
