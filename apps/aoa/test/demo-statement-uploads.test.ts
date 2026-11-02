// The public demo stores no visitor files: the statement route refuses an upload before it reads the bytes, offers
// the demo's sample statement instead (stored once a transfer, however often it is chosen), and still serves the
// stored files. Outside the demo the route is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), revalidate: vi.fn(), record: vi.fn(), download: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("next/cache", () => ({ revalidatePath: spies.revalidate }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: () => true,
}));
vi.mock("@/lib/data/transfer-statement-documents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordStatementSubmission: spies.record,
  readStatementDownload: spies.download,
}));

import { POST } from "@/app/api/asset-transfer/[transferId]/statements/route";
import { GET } from "@/app/api/asset-transfer/[transferId]/statements/[documentId]/route";
import { demoSampleStatement } from "@/lib/demo/sample-statement";
import { DEMO_SAMPLE_STATEMENT_FILENAME, STATEMENT_MESSAGES } from "@/lib/transfers/statement-document";

const PDF = Buffer.from("%PDF-1.4\n% synthetic test statement\n%%EOF\n");
const transferParams = { params: Promise.resolve({ transferId: "synthetic-transfer" }) };
const documentParams = { params: Promise.resolve({ transferId: "synthetic-transfer", documentId: "synthetic-document" }) };

function post(fields: Record<string, string>, file: File | null, headers: Record<string, string> = {}) {
  const body = new FormData();
  body.set("version", "none");
  body.set("statementDate", "2026-09-30");
  body.set("review", "pending");
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  if (file) body.set("file", file);
  return POST(new Request("http://localhost/api/asset-transfer/synthetic-transfer/statements", {
    method: "POST", body, headers: { host: "localhost", ...headers },
  }), transferParams);
}
const pdfFile = () => new File([PDF], "Visitor.pdf", { type: "application/pdf" });

beforeEach(() => {
  vi.clearAllMocks();
  spies.auth.mockResolvedValue({ user: { email: "synthetic.user@example.test", role: "OPERATIONS" } });
  spies.scope.mockImplementation(async (_identity: unknown, fn: (tx: unknown) => unknown) => fn({}));
  spies.record.mockResolvedValue({ ok: true, reviewStatus: "pending", message: "Statement added. Preparation waits for statement review." });
  spies.download.mockResolvedValue({ filename: "Stored.pdf", contentType: "application/pdf", content: PDF, sha256: "a".repeat(64) });
});
afterEach(() => vi.unstubAllEnvs());

describe("statement uploads in the public demo", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on"));

  it("refuses a visitor's file, by its declared size or once read, and stores nothing", async () => {
    const declared = await post({}, null, { "content-length": String(200 * 1024) });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ ok: false, message: STATEMENT_MESSAGES.demoUploadsOff });
    const read = await post({}, pdfFile());
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ ok: false, message: STATEMENT_MESSAGES.demoUploadsOff });
    // A file sent alongside the sample is still a visitor's file.
    expect((await post({ sample: "1" }, pdfFile())).status).toBe(403);
    expect(spies.record).not.toHaveBeenCalled();
  });

  it("records the sample statement, reusing the transfer's stored copy", async () => {
    const response = await post({ sample: "1", review: "yes" }, null);
    expect(response.status).toBe(200);
    const input = spies.record.mock.calls[0][3];
    expect(input).toMatchObject({ review: "yes", documentId: undefined, reuseStoredCopy: true });
    expect(input.file).toMatchObject({ filename: DEMO_SAMPLE_STATEMENT_FILENAME, contentType: "application/pdf" });
    expect(input.file.content.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("still reviews the pending stored file and downloads stored files", async () => {
    expect((await post({ documentId: "synthetic-document" }, null)).status).toBe(200);
    expect(spies.record.mock.calls[0][3]).toMatchObject({ documentId: "synthetic-document", file: undefined, reuseStoredCopy: false });
    const download = await GET(new Request("http://localhost/x"), documentParams);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(PDF)).toBe(true);
  });
});

describe("statement uploads outside the demo", () => {
  it("stores the uploaded file as before and ignores a sample request", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    expect((await post({}, pdfFile())).status).toBe(200);
    const input = spies.record.mock.calls[0][3];
    expect(input).toMatchObject({ reuseStoredCopy: false });
    expect(input.file).toMatchObject({ filename: "Visitor.pdf", byteSize: PDF.byteLength });
    spies.record.mockClear();
    await post({ sample: "1" }, null);
    expect(spies.record.mock.calls[0][3]).toMatchObject({ file: undefined, reuseStoredCopy: false });
  });
});

describe("the demo's sample statement", () => {
  it("is a checked PDF whose bytes don't change between builds", async () => {
    const first = await demoSampleStatement();
    vi.resetModules();
    const again = await (await import("@/lib/demo/sample-statement")).demoSampleStatement();
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(again.sha256).toBe(first.sha256);
    expect(first.byteSize).toBeLessThan(16 * 1024);
  });
});
