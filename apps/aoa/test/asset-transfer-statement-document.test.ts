import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const flags = vi.hoisted(() => ({ workspace: vi.fn(() => true), paperwork: vi.fn(() => true) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: flags.workspace,
  paperworkRecordsEnabled: flags.paperwork,
}));

import {
  NO_STATEMENT,
  STATEMENT_MAX_BYTES,
  STATEMENT_MESSAGES,
  currentStatementSummary,
  deliveringStatementLine,
  reviewStatusFromOption,
  statementButtonLabel,
  statementCheckHelp,
  statementCheckTitle,
  statementDialogTitle,
  statementFileProblem,
  statementLongDate,
  type StatementView,
} from "@/lib/transfers/statement-document";
import {
  buildStatementDocument,
  parseStatementDate,
  readStatementRecords,
  recordStatementSubmission,
  safeStatementFilename,
  StatementUploadError,
} from "@/lib/data/transfer-statement-documents";

const SUITE = "asset-transfer-statement-document";
const PDF = Buffer.from("%PDF-1.4\n% synthetic test statement\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const NOW = new Date("2026-10-23T16:00:00Z");
const IDENTITY = { role: "CLIENT_SERVICE", email: "synthetic.cs@example.test" };

const view = (overrides: Partial<StatementView>): StatementView => ({
  provided: true, accepted: false, reviewStatus: "pending", filename: "Synthetic statement.pdf", statementDate: "2026-09-30",
  ...overrides,
});

describe("statement copy follows the mockup", () => {
  it("no-statement-copy", () => {
    expect(statementCheckTitle(NO_STATEMENT)).toBe("Current statement needed");
    expect(statementCheckHelp(NO_STATEMENT)).toBe("Dated not recorded. Add and review a statement to begin transfer preparation.");
    expect(statementButtonLabel(NO_STATEMENT)).toBe("Add statement");
    expect(statementDialogTitle(NO_STATEMENT)).toBe("Add a statement");
    expect(deliveringStatementLine(NO_STATEMENT)).toBe("No statement provided yet");
    expect(currentStatementSummary(NO_STATEMENT)).toEqual({
      name: "No statement provided yet",
      detail: "Add this source account’s statement and review it before preparing the transfer.",
    });
    markCase(SUITE, "no-statement-copy");
  });

  it("pending-statement-copy", () => {
    const pending = view({});
    expect(statementCheckTitle(pending)).toBe("Statement awaiting review");
    expect(statementCheckHelp(pending)).toBe("Dated September 30, 2026. Review this statement to unblock transfer preparation.");
    expect(statementButtonLabel(pending)).toBe("Review statement");
    expect(statementDialogTitle(pending)).toBe("Add an updated statement");
    expect(deliveringStatementLine(pending)).toBe("Statement: 2026-09-30");
    expect(currentStatementSummary(pending)).toEqual({ name: "Synthetic statement.pdf", detail: "Dated September 30, 2026 · Awaiting review" });
    markCase(SUITE, "pending-statement-copy");
  });

  it("accepted-and-replacement-copy", () => {
    const accepted = view({ accepted: true, reviewStatus: "accepted" });
    expect(statementCheckTitle(accepted)).toBe("Current statement accepted");
    expect(statementCheckHelp(accepted)).toBe("Dated September 30, 2026. Ready for mapping and review.");
    expect(statementButtonLabel(accepted)).toBe("Add updated statement");
    const replace = view({ reviewStatus: "replacement_needed" });
    expect(statementCheckTitle(replace)).toBe("Current statement needed");
    expect(statementCheckHelp(replace)).toBe("Dated September 30, 2026. Replace this statement to unblock transfer preparation.");
    expect(currentStatementSummary(replace).detail).toBe("Dated September 30, 2026 · Needs replacement");
    markCase(SUITE, "accepted-and-replacement-copy");
  });

  it("legacy-review-without-file", () => {
    const legacy = view({ accepted: true, reviewStatus: null, filename: null, statementDate: null });
    expect(statementCheckTitle(legacy)).toBe("Current statement accepted");
    expect(deliveringStatementLine(legacy)).toBe("Statement: date pending");
    expect(currentStatementSummary(legacy)).toEqual({ name: "Statement file not stored", detail: "Dated not recorded · Accepted" });
    expect(statementLongDate("2026-06-30")).toBe("June 30, 2026");
    markCase(SUITE, "legacy-review-without-file");
  });
});

describe("statement file validation", () => {
  it("client-file-check", () => {
    expect(statementFileProblem("statement.pdf", 10)).toBeNull();
    expect(statementFileProblem("statement.JPEG", 10)).toBeNull();
    expect(statementFileProblem("statement.docx", 10)).toBe(STATEMENT_MESSAGES.badFile);
    expect(statementFileProblem("statement.pdf", 0)).toBe(STATEMENT_MESSAGES.badFile);
    expect(statementFileProblem(undefined, undefined)).toBe(STATEMENT_MESSAGES.badFile);
    expect(statementFileProblem("statement.pdf", STATEMENT_MAX_BYTES + 1)).toBe(STATEMENT_MESSAGES.tooLarge);
    markCase(SUITE, "client-file-check");
  });

  it("server-accepts-signed-types", () => {
    const pdf = buildStatementDocument({ filename: "Synthetic Statement.pdf", contentType: "application/pdf", content: PDF });
    expect(pdf).toMatchObject({ contentType: "application/pdf", byteSize: PDF.byteLength, filename: "Synthetic Statement.pdf" });
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildStatementDocument({ filename: "a.png", contentType: "", content: PNG }).contentType).toBe("image/png");
    expect(buildStatementDocument({ filename: "a.jpg", contentType: "application/octet-stream", content: JPG }).contentType)
      .toBe("image/jpeg");
    markCase(SUITE, "server-accepts-signed-types");
  });

  it("server-refuses-bad-files", () => {
    const refuse = (input: { filename: string; contentType: string; content: Uint8Array }, status: number) => {
      try {
        buildStatementDocument(input);
      } catch (error) {
        expect(error).toBeInstanceOf(StatementUploadError);
        expect((error as StatementUploadError).status).toBe(status);
        return;
      }
      throw new Error("expected a refusal");
    };
    refuse({ filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array() }, 400);
    refuse({ filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array(STATEMENT_MAX_BYTES + 1) }, 413);
    refuse({ filename: "a.html", contentType: "text/html", content: Buffer.from("<html>") }, 415);
    refuse({ filename: "a.png", contentType: "application/pdf", content: PDF }, 415);
    refuse({ filename: "a.pdf", contentType: "application/pdf", content: PNG }, 415);
    markCase(SUITE, "server-refuses-bad-files");
  });

  it("filename-and-date", () => {
    expect(safeStatementFilename("../../etc/<script>.pdf")).toBe("-script-.pdf");
    expect(safeStatementFilename("C:\\Users\\x\\June statement.pdf")).toBe("June statement.pdf");
    expect(parseStatementDate("2026-09-30", NOW)).toEqual(new Date("2026-09-30T00:00:00.000Z"));
    expect(parseStatementDate("2026-02-30", NOW)).toBe(STATEMENT_MESSAGES.badDate);
    expect(parseStatementDate("", NOW)).toBe(STATEMENT_MESSAGES.badDate);
    expect(parseStatementDate("2026-10-24", NOW)).toBe(STATEMENT_MESSAGES.futureDate);
    expect(reviewStatusFromOption("yes")).toBe("accepted");
    expect(reviewStatusFromOption("no")).toBe("replacement_needed");
    expect(reviewStatusFromOption("pending")).toBe("pending");
    expect(reviewStatusFromOption("accepted")).toBeNull();
    markCase(SUITE, "filename-and-date");
  });
});

type Row = Record<string, unknown> & { id: string; created_at: Date };

function fakeTx() {
  const state = {
    transfer: { archived_at: null as Date | null, funding_plan_approved_at: new Date("2026-10-01T12:00:00Z") as Date | null },
    submission: null as { id: string } | null,
    outcome: null as { id: string; outcome: string; resumed: boolean } | null,
    statements: [] as Row[],
    documents: [] as Row[],
    audits: [] as { action: string; detail: string | null; entityType: string | null }[],
  };
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 23, 12, 0, clock++));
  const latest = (rows: Row[]) => [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null;
  const pick = (row: Row | null, select?: Record<string, boolean>) =>
    row && select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null])) : row;
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "synthetic-transfer" }]),
    transfer: {
      findUnique: vi.fn(async () => state.transfer),
      updateMany: vi.fn(async () => {
        if (!state.transfer.funding_plan_approved_at) return { count: 0 };
        state.transfer.funding_plan_approved_at = null;
        return { count: 1 };
      }),
    },
    transferSubmission: { findFirst: vi.fn(async () => state.submission) },
    transferOutcome: { findFirst: vi.fn(async () => state.outcome) },
    transferStatement: {
      findFirst: vi.fn(async ({ select }: { select?: Record<string, boolean> }) => pick(latest(state.statements), select)),
      findMany: vi.fn(async () => [...state.statements].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `stmt-${state.statements.length + 1}`, created_at: stamp(), document_id: null, statement_date: null, review_status: null, ...data };
        state.statements.push(row);
        return { id: row.id };
      }),
    },
    transferStatementDocument: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.documents.push({ ...(data as { id: string }), created_at: stamp() });
        return { id: data.id };
      }),
      findMany: vi.fn(async () => [...state.documents].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: { action: string; detail: string | null; entityType: string | null } }) => {
        state.audits.push(data);
      }),
    },
  };
  return { tx: tx as never, state };
}

describe("recording a statement", () => {
  beforeEach(() => {
    flags.workspace.mockReturnValue(true);
    flags.paperwork.mockReturnValue(true);
  });

  const file = () => buildStatementDocument({ filename: "Synthetic statement.pdf", contentType: "application/pdf", content: PDF });

  it("upload-stores-file-and-pending-review", async () => {
    const { tx, state } = fakeTx();
    const result = await recordStatementSubmission(tx, IDENTITY, "synthetic-transfer", {
      version: "none", statementDate: "2026-09-30", review: "pending", file: file(),
    }, NOW);
    expect(result).toEqual({ ok: true, reviewStatus: "pending", message: "Statement added. Preparation waits for statement review." });
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]).toMatchObject({ transfer_id: "synthetic-transfer", content_type: "application/pdf", created_by: IDENTITY.email });
    expect(state.statements[0]).toMatchObject({ accepted: false, review_status: "pending", document_id: state.documents[0].id });
    expect(state.audits.map((a) => a.action)).toEqual(["transfer.statement_upload", "transfer.statement_record"]);
    expect(state.audits.map((a) => a.detail).join(" ")).not.toContain("Synthetic statement");
    expect(state.transfer.funding_plan_approved_at).not.toBeNull();

    const records = await readStatementRecords(tx, "synthetic-transfer");
    expect(records.latest).toMatchObject({ provided: true, accepted: false, reviewStatus: "pending", statementDate: "2026-09-30" });
    expect(records.pendingFile).toMatchObject({ id: state.documents[0].id, statementDate: "2026-09-30" });
    markCase(SUITE, "upload-stores-file-and-pending-review");
  });

  it("review-only-accepts-pending-file", async () => {
    const { tx, state } = fakeTx();
    await recordStatementSubmission(tx, IDENTITY, "synthetic-transfer", {
      version: "none", statementDate: "2026-09-30", review: "pending", file: file(),
    }, NOW);
    const documentId = state.documents[0].id;
    const result = await recordStatementSubmission(tx, IDENTITY, "synthetic-transfer", {
      version: "stmt-1", statementDate: "2026-09-30", review: "yes", documentId,
    }, NOW);
    expect(result).toMatchObject({ ok: true, reviewStatus: "accepted" });
    expect(state.documents).toHaveLength(1);
    expect(state.statements[1]).toMatchObject({ accepted: true, review_status: "accepted", document_id: documentId });
    expect(state.transfer.funding_plan_approved_at).toBeNull();
    markCase(SUITE, "review-only-accepts-pending-file");
  });

  it("updated-statement-keeps-history", async () => {
    const { tx, state } = fakeTx();
    await recordStatementSubmission(tx, IDENTITY, "synthetic-transfer", {
      version: "none", statementDate: "2026-06-30", review: "no", file: file(),
    }, NOW);
    await recordStatementSubmission(tx, IDENTITY, "synthetic-transfer", {
      version: "stmt-1", statementDate: "2026-09-30", review: "yes", file: file(),
    }, NOW);
    const records = await readStatementRecords(tx, "synthetic-transfer");
    expect(records.latest).toMatchObject({ accepted: true, statementDate: "2026-09-30" });
    expect(records.previous).toEqual([
      { id: state.documents[0].id, filename: "Synthetic statement.pdf", statementDate: "2026-06-30", version: 1 },
    ]);
    expect(records.pendingFile).toBeNull();
    markCase(SUITE, "updated-statement-keeps-history");
  });

  it("refusals-write-nothing", async () => {
    const cases: [Partial<Parameters<typeof recordStatementSubmission>[3]>, (s: ReturnType<typeof fakeTx>["state"]) => void, string][] = [
      [{ review: "maybe" }, () => {}, STATEMENT_MESSAGES.badReview],
      [{ statementDate: "2026-13-01" }, () => {}, STATEMENT_MESSAGES.badDate],
      [{ file: undefined }, () => {}, STATEMENT_MESSAGES.noFile],
      [{}, (s) => { s.submission = { id: "sub-1" }; }, STATEMENT_MESSAGES.submitted],
      [{}, (s) => { s.outcome = { id: "out-1", outcome: "Deferred", resumed: false }; }, STATEMENT_MESSAGES.paused],
      [{ version: "stmt-old" }, () => {}, STATEMENT_MESSAGES.stale],
      [{ file: undefined, documentId: "not-pending" }, () => {}, STATEMENT_MESSAGES.stale],
    ];
    for (const [override, arrange, message] of cases) {
      const { tx, state } = fakeTx();
      arrange(state);
      const result = await recordStatementSubmission(tx, IDENTITY, "synthetic-transfer", {
        version: "none", statementDate: "2026-09-30", review: "pending", file: file(), ...override,
      }, NOW);
      expect(result).toMatchObject({ ok: false, message });
      expect(state.documents).toHaveLength(0);
      expect(state.statements).toHaveLength(0);
      expect(state.audits).toHaveLength(0);
    }
    markCase(SUITE, "refusals-write-nothing");
  });
});
