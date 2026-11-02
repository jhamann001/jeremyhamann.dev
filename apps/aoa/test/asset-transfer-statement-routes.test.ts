import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), revalidate: vi.fn(), workspace: vi.fn(), record: vi.fn(), download: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("next/cache", () => ({ revalidatePath: spies.revalidate }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: spies.workspace,
}));
vi.mock("@/lib/data/transfer-statement-documents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordStatementSubmission: spies.record,
  readStatementDownload: spies.download,
}));

import { POST } from "@/app/api/asset-transfer/[transferId]/statements/route";
import { GET } from "@/app/api/asset-transfer/[transferId]/statements/[documentId]/route";
import { STATEMENT_MESSAGES } from "@/lib/transfers/statement-document";

const SUITE = "asset-transfer-statement-routes";
const PDF = Buffer.from("%PDF-1.4\n% synthetic test statement\n%%EOF\n");
const transferParams = { params: Promise.resolve({ transferId: "synthetic-transfer" }) };
const documentParams = { params: Promise.resolve({ transferId: "synthetic-transfer", documentId: "synthetic-document" }) };

function signIn(role: string | null) {
  spies.auth.mockResolvedValue(role ? { user: { email: "synthetic.user@example.test", role } } : null);
}

function upload(fields: Record<string, string> = {}, file: File | null = new File([PDF], "Synthetic.pdf", { type: "application/pdf" }), headers: Record<string, string> = {}) {
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

beforeEach(() => {
  vi.clearAllMocks();
  spies.workspace.mockReturnValue(true);
  spies.scope.mockImplementation(async (_identity: unknown, fn: (tx: unknown) => unknown) => fn({}));
  spies.record.mockResolvedValue({ ok: true, reviewStatus: "pending", message: "Statement added. Preparation waits for statement review." });
  spies.download.mockResolvedValue({ filename: "Synthetic.pdf", contentType: "application/pdf", content: PDF, sha256: "a".repeat(64) });
  signIn("CLIENT_SERVICE");
});

describe("statement upload route", () => {
  it("flag-off-is-not-found", async () => {
    spies.workspace.mockReturnValue(false);
    expect((await upload()).status).toBe(404);
    expect((await GET(new Request("http://localhost/x"), documentParams)).status).toBe(404);
    expect(spies.auth).not.toHaveBeenCalled();
    expect(spies.record).not.toHaveBeenCalled();
    expect(spies.download).not.toHaveBeenCalled();
    markCase(SUITE, "flag-off-is-not-found");
  });

  it("upload-roles", async () => {
    signIn(null);
    expect((await upload()).status).toBe(401);
    for (const role of ["VIEWER", "ADVISOR", "HEAD_OF_ADVISORY"]) {
      signIn(role);
      const response = await upload();
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, message: STATEMENT_MESSAGES.role });
    }
    expect(spies.record).not.toHaveBeenCalled();
    for (const role of ["CLIENT_SERVICE", "OPERATIONS", "ADMIN"]) {
      signIn(role);
      expect((await upload()).status).toBe(200);
    }
    markCase(SUITE, "upload-roles");
  });

  it("cross-site-post-refused", async () => {
    const response = await upload({}, undefined, { origin: "https://elsewhere.example" });
    expect(response.status).toBe(403);
    expect(spies.record).not.toHaveBeenCalled();
    expect((await upload({}, undefined, { origin: "http://localhost" })).status).toBe(200);
    markCase(SUITE, "cross-site-post-refused");
  });

  it("bad-files-refused-before-write", async () => {
    const html = await upload({}, new File(["<html>"], "statement.html", { type: "text/html" }));
    expect(html.status).toBe(415);
    expect(await html.json()).toEqual({ ok: false, message: STATEMENT_MESSAGES.badFile });
    const spoofed = await upload({}, new File(["not a pdf"], "statement.pdf", { type: "application/pdf" }));
    expect(spoofed.status).toBe(415);
    const big = await upload({}, null, { "content-length": String(11 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect(spies.record).not.toHaveBeenCalled();
    markCase(SUITE, "bad-files-refused-before-write");
  });

  it("valid-upload-records-and-revalidates", async () => {
    const response = await upload({ review: "yes" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "Statement added. Preparation waits for statement review." });
    const [, identity, transferId, input] = spies.record.mock.calls[0];
    expect(identity).toEqual({ role: "CLIENT_SERVICE", email: "synthetic.user@example.test" });
    expect(transferId).toBe("synthetic-transfer");
    expect(input).toMatchObject({ version: "none", statementDate: "2026-09-30", review: "yes", documentId: undefined });
    expect(input.file).toMatchObject({ contentType: "application/pdf", byteSize: PDF.byteLength });
    expect(spies.revalidate).toHaveBeenCalledWith("/asset-transfer/synthetic-transfer");
    markCase(SUITE, "valid-upload-records-and-revalidates");
  });

  it("review-only-and-refusal-status", async () => {
    spies.record.mockResolvedValueOnce({ ok: false, status: 409, message: STATEMENT_MESSAGES.submitted });
    const refused = await upload({ documentId: "synthetic-document" }, null);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, message: STATEMENT_MESSAGES.submitted });
    expect(spies.record.mock.calls[0][3]).toMatchObject({ documentId: "synthetic-document", file: undefined });
    expect(spies.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "review-only-and-refusal-status");
  });
});

describe("statement download route", () => {
  it("download-roles", async () => {
    signIn(null);
    expect((await GET(new Request("http://localhost/x"), documentParams)).status).toBe(401);
    for (const role of ["VIEWER", "HEAD_OF_ADVISORY"]) {
      signIn(role);
      expect((await GET(new Request("http://localhost/x"), documentParams)).status).toBe(403);
    }
    expect(spies.download).not.toHaveBeenCalled();
    markCase(SUITE, "download-roles");
  });

  it("download-returns-attachment", async () => {
    signIn("ADVISOR");
    const response = await GET(new Request("http://localhost/x"), documentParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="Synthetic\.pdf"/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true);
    expect(spies.download).toHaveBeenCalledWith(
      { role: "ADVISOR", email: "synthetic.user@example.test" }, "synthetic-transfer", "synthetic-document",
    );
    spies.download.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/x"), documentParams)).status).toBe(404);
    markCase(SUITE, "download-returns-attachment");
  });
});
