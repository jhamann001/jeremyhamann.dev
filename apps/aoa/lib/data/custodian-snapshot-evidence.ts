export const MOVE_CHECK_KIND_RANK = {
  custodian: 0,
  fee_rule: 1,
  fee_schedule_file: 2,
} as const;

export type MoveCheckKind = keyof typeof MOVE_CHECK_KIND_RANK;

export type MoveCheckItem = {
  readonly kind: MoveCheckKind;
  readonly originalId: string;
  readonly authorityId: string;
  readonly byteCount: number;
  readonly checksum: string;
  readonly revision: number | null;
};

export type StoredEvidenceItem = {
  readonly kind: MoveCheckKind;
  readonly originalId: string;
  readonly authorityId: string;
  readonly byteCount: number;
  readonly checksum: string;
  readonly revision: bigint | number | null;
  readonly confirmed: boolean;
};

export type MoveCheckReport =
  | { readonly refused: null; readonly snapshotSha256: string; readonly items: readonly MoveCheckItem[] }
  | { readonly refused: "evidence_missing"; readonly snapshotSha256: string }
  | { readonly refused: "incomplete"; readonly snapshotSha256: string; readonly storedCount: number; readonly confirmedCount: number };

export const EVIDENCE_REPORT_SELECT = {
  id: true,
  snapshotSha256: true,
  items: {
    select: {
      kind: true,
      originalId: true,
      authorityId: true,
      byteCount: true,
      checksum: true,
      revision: true,
      confirmed: true,
    },
  },
} as const;

export const REPORT_IDENTITY = {
  role: "ADMIN" as const,
  email: "custodian-snapshot-report@example.test",
};

function traceReport(fields: { outcome: "ok" | "evidence_missing" | "incomplete"; itemCount: number }): void {
  const runId = process.env.TEST_RUN_ID ?? "runtime";
  console.error(JSON.stringify({
    feature: "custodian-snapshot-evidence",
    operation: "report",
    outcome: fields.outcome,
    item_count: fields.itemCount,
    run_id: runId,
  }));
}

export function compareOriginalId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function orderMoveCheckItems<T extends { kind: MoveCheckKind; originalId: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const byKind = MOVE_CHECK_KIND_RANK[left.kind] - MOVE_CHECK_KIND_RANK[right.kind];
    return byKind !== 0 ? byKind : compareOriginalId(left.originalId, right.originalId);
  });
}

export function revisionNumber(value: bigint | number | null): number | null {
  if (value == null) return null;
  const revision = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(revision)) throw new Error("revision_not_safe");
  return revision;
}

export function buildMoveCheckReport(snapshotSha256: string, stored: readonly StoredEvidenceItem[] | null): MoveCheckReport {
  if (stored == null) {
    const report: MoveCheckReport = { refused: "evidence_missing", snapshotSha256 };
    traceReport({ outcome: "evidence_missing", itemCount: 0 });
    return report;
  }
  const confirmedCount = stored.filter((item) => item.confirmed).length;
  if (confirmedCount !== stored.length) {
    const report: MoveCheckReport = { refused: "incomplete", snapshotSha256, storedCount: stored.length, confirmedCount };
    traceReport({ outcome: "incomplete", itemCount: stored.length });
    return report;
  }
  const items = orderMoveCheckItems(stored).map((item) => ({
    kind: item.kind,
    originalId: item.originalId,
    authorityId: item.authorityId,
    byteCount: item.byteCount,
    checksum: item.checksum,
    revision: revisionNumber(item.revision),
  }));
  const report: MoveCheckReport = { refused: null, snapshotSha256, items };
  traceReport({ outcome: "ok", itemCount: items.length });
  return report;
}

type EvidenceReadClient = {
  custodianSnapshotImport: {
    findUnique(args: { where: { snapshotSha256: string }; select: typeof EVIDENCE_REPORT_SELECT }): Promise<{
      items: StoredEvidenceItem[];
    } | null>;
  };
};

export async function readStoredEvidence(snapshotSha256: string, db: EvidenceReadClient): Promise<StoredEvidenceItem[] | null> {
  const run = await db.custodianSnapshotImport.findUnique({
    where: { snapshotSha256 },
    select: EVIDENCE_REPORT_SELECT,
  });
  return run ? run.items : null;
}

export async function reportCustodianSnapshot(snapshotSha256: string, db: EvidenceReadClient): Promise<MoveCheckReport> {
  return buildMoveCheckReport(snapshotSha256, await readStoredEvidence(snapshotSha256, db));
}
