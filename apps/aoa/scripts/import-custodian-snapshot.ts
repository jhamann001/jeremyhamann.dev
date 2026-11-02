import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CustodianSnapshot,
  FeeScheduleInsert,
  ImportCustodianSnapshotDeps,
  StoredImportItem,
} from "@/lib/data/custodian-snapshot-import";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

type AuthorityModule = {
  saveCustodianAuthority: ImportCustodianSnapshotDeps["saveCustodianAuthority"];
  confirmCustodianAuthorityRevision: ImportCustodianSnapshotDeps["confirmCustodianAuthorityRevision"];
  listCustodianAuthorityRevisions: ImportCustodianSnapshotDeps["listCustodianAuthorityRevisions"];
};

type ImportModule = {
  IMPORT_IDENTITY: { role: "ADMIN"; email: string };
  importCustodianSnapshot: (
    snapshot: CustodianSnapshot,
    files: Readonly<Record<string, Uint8Array>>,
    deps: ImportCustodianSnapshotDeps,
  ) => Promise<{ refused: string | null; snapshotSha256: string | null; runId: string | null }>;
};

type EvidenceTx = {
  custodianAuthorityState: {
    findUniqueOrThrow(args: { where: { id: number } }): Promise<{
      accepted_revision: bigint;
      confirmed_revision: bigint;
    }>;
  };
  custodianSnapshotImport: {
    findUnique(args: { where: { snapshotSha256: string }; include: { items: true } }): Promise<{
      id: string;
      items: Array<Omit<StoredImportItem, "revision"> & { revision: bigint | null }>;
    } | null>;
    create(args: { data: { snapshotSha256: string } }): Promise<{ id: string }>;
  };
  custodianSnapshotImportItem: {
    upsert(args: {
      where: { importId_kind_originalId: { importId: string; kind: string; originalId: string } };
      create: {
        importId: string;
        kind: StoredImportItem["kind"];
        originalId: string;
        authorityId: string;
        byteCount: number;
        checksum: string;
        revision: bigint | null;
        confirmed: boolean;
      };
      update: { byteCount: number; checksum: string; revision: bigint | null; authorityId: string; confirmed: boolean };
    }): Promise<unknown>;
  };
  custodianFeeScheduleDocument: {
    findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
    create(args: { data: FeeScheduleInsert & { content: Buffer } }): Promise<unknown>;
  };
};

type ScopeModule = {
  withUserScope: <T>(
    identity: ImportModule["IMPORT_IDENTITY"],
    fn: (tx: EvidenceTx) => Promise<T>,
  ) => Promise<T>;
};

export function readEvidenceRevision(value: bigint | number | null): number | null {
  if (value == null) return null;
  const revision = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(revision)) throw new Error("revision_not_safe");
  return revision;
}

function installServerOnlyResolver(): void {
  require("tsx/cjs");
  const moduleApi = require("node:module") as {
    _resolveFilename: (this: unknown, request: string, ...args: unknown[]) => string;
  };
  const original = moduleApi._resolveFilename;
  const marker = require.resolve("next/dist/compiled/server-only/empty.js");
  moduleApi._resolveFilename = function (this: unknown, request: string, ...args: unknown[]) {
    return request === "server-only" ? marker : original.call(this, request, ...args);
  };
}

function loadApp(): { authority: AuthorityModule; importer: ImportModule; scope: ScopeModule } {
  installServerOnlyResolver();
  return {
    authority: require(path.join(root, "lib/data/custodian-authority.ts")) as AuthorityModule,
    importer: require(path.join(root, "lib/data/custodian-snapshot-import.ts")) as ImportModule,
    scope: require(path.join(root, "lib/rls.ts")) as ScopeModule,
  };
}

function flagOn(): boolean {
  return process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 === "1";
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error("usage");
  return value;
}

async function main(): Promise<number> {
  if (!flagOn()) {
    process.stdout.write("{\"refused\":\"flag_off\"}\n");
    return 2;
  }
  if (!process.env.DATABASE_URL) throw new Error("usage");
  const { authority, importer, scope } = loadApp();
  const directory = arg("--snapshot");
  const snapshot = JSON.parse(readFileSync(path.join(directory, "snapshot.json"), "utf8")) as CustodianSnapshot;
  const files: Record<string, Uint8Array> = {};
  for (const name of readdirSync(path.join(directory, "files"))) {
    files[name] = readFileSync(path.join(directory, "files", name));
  }
  const receipt = await importer.importCustodianSnapshot(snapshot, files, {
    saveCustodianAuthority: authority.saveCustodianAuthority,
    confirmCustodianAuthorityRevision: authority.confirmCustodianAuthorityRevision,
    listCustodianAuthorityRevisions: authority.listCustodianAuthorityRevisions,
    readAuthorityState: () => scope.withUserScope(importer.IMPORT_IDENTITY, async (tx) => {
      const row = await tx.custodianAuthorityState.findUniqueOrThrow({ where: { id: 1 } });
      return { acceptedRevision: row.accepted_revision, confirmedRevision: row.confirmed_revision };
    }),
    evidence: {
      findRun: (snapshotSha256) => scope.withUserScope(importer.IMPORT_IDENTITY, async (tx) => {
        const run = await tx.custodianSnapshotImport.findUnique({ where: { snapshotSha256 }, include: { items: true } });
        if (!run) return null;
        return {
          id: run.id,
          items: run.items.map((item) => ({
            kind: item.kind,
            originalId: item.originalId,
            authorityId: item.authorityId,
            byteCount: item.byteCount,
            checksum: item.checksum,
            revision: readEvidenceRevision(item.revision),
            confirmed: item.confirmed,
          })),
        };
      }),
      createRun: (snapshotSha256) => scope.withUserScope(importer.IMPORT_IDENTITY, async (tx) => {
        const created = await tx.custodianSnapshotImport.create({ data: { snapshotSha256 } });
        return { id: created.id };
      }),
      upsertItem: (importId, item) => scope.withUserScope(importer.IMPORT_IDENTITY, async (tx) => {
        const revision = item.revision == null ? null : BigInt(item.revision);
        await tx.custodianSnapshotImportItem.upsert({
          where: { importId_kind_originalId: { importId, kind: item.kind, originalId: item.originalId } },
          create: {
            importId,
            kind: item.kind,
            originalId: item.originalId,
            authorityId: item.authorityId,
            byteCount: item.byteCount,
            checksum: item.checksum,
            revision,
            confirmed: item.confirmed,
          },
          update: { byteCount: item.byteCount, checksum: item.checksum, revision, authorityId: item.authorityId, confirmed: item.confirmed },
        });
      }),
    },
    findFeeSchedule: (originalId) => scope.withUserScope(importer.IMPORT_IDENTITY, async (tx) => {
      return tx.custodianFeeScheduleDocument.findUnique({ where: { id: originalId }, select: { id: true } });
    }),
    insertFeeSchedule: (row: FeeScheduleInsert) => scope.withUserScope(importer.IMPORT_IDENTITY, async (tx) => {
      await tx.custodianFeeScheduleDocument.create({ data: { ...row, content: Buffer.from(row.content) } });
    }),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return receipt.refused ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "usage"}\n`);
    process.exitCode = 1;
  });
}
