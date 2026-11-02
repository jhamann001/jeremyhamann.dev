import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const ARCHIVE_FORMAT_VERSION = 1 as const;
export const ARCHIVE_AAD = "ops-portal:legacy-dev-data:v1";
export const GCM_AUTH_TAG_BYTES = 16;
export const SOURCE_PROJECT = "ops-portal";
export const SOURCE_DATABASE = "aoa_dev";
export const TARGET_PROJECT = "ops-portal-dev";
export const TARGET_DATABASE = "aoa";
export const EXPORT_APPROVAL = "EXPORT-LEGACY-AOA-DEV";
export const IMPORT_APPROVAL = "IMPORT-INTO-CANONICAL-AOA-DEV";
export const MIGRATION_ACTION = "migration.legacy_dev_import";
// pg_advisory_xact_lock returns PostgreSQL's `void` type. Prisma cannot
// deserialize `void`, so cast it to text while preserving the locking side
// effect. Keep this SQL exported so the database integration suite exercises
// the exact statement used by the one-time importer.
export const LEGACY_DEV_ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('aoa-legacy-dev-import-v1'))::text AS lock_status";

export const MIGRATION_TABLES = [
  {
    schema: "app",
    table: "deal",
    expectedRows: 286,
    preserveId: true,
  },
  {
    schema: "app",
    table: "transfer",
    expectedRows: 1,
    preserveId: true,
  },
  {
    schema: "app",
    table: "transfer_task",
    expectedRows: 6,
    preserveId: true,
  },
  {
    schema: "app",
    table: "transfer_account",
    expectedRows: 0,
    preserveId: true,
  },
  {
    schema: "app",
    table: "transfer_decision",
    expectedRows: 0,
    preserveId: true,
  },
  {
    schema: "app",
    table: "transfer_position_flag",
    expectedRows: 0,
    preserveId: true,
  },
  {
    schema: "app",
    table: "transfer_slack_closeout",
    expectedRows: 1,
    preserveId: true,
  },
  {
    schema: "app",
    table: "transfer_slack_item",
    expectedRows: 7,
    preserveId: true,
  },
  {
    schema: "app",
    table: "meeting_prep",
    expectedRows: 3,
    preserveId: true,
  },
  {
    schema: "audit",
    table: "AuditLog",
    expectedRows: 132,
    preserveId: false,
  },
  {
    schema: "audit",
    table: "row_change",
    expectedRows: 878,
    preserveId: false,
  },
] as const;

export type MigrationTable = (typeof MIGRATION_TABLES)[number];
export type MigrationTableKey =
  `${MigrationTable["schema"]}.${MigrationTable["table"]}`;
export type MigrationMode = "export" | "import";

export type TableArchive = {
  rows: number;
  payloadBase64: string;
  payloadSha256: string;
};

export type LegacyDevArchive = {
  formatVersion: typeof ARCHIVE_FORMAT_VERSION;
  createdAt: string;
  sourceProject: typeof SOURCE_PROJECT;
  sourceDatabase: typeof SOURCE_DATABASE;
  sourceMigrations: string[];
  schemaSignature: string;
  tables: Record<MigrationTableKey, TableArchive>;
};

export type EncryptedArchive = {
  formatVersion: typeof ARCHIVE_FORMAT_VERSION;
  cipher: "aes-256-gcm";
  archiveSha256: string;
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
};

export type ParsedMigrationArgs = {
  mode: MigrationMode;
  execute: boolean;
  approval: string | null;
  bucket: string | null;
  object: string | null;
};

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

export function tableKey(
  table: Pick<MigrationTable, "schema" | "table">,
): MigrationTableKey {
  return `${table.schema}.${table.table}` as MigrationTableKey;
}

export function parseMigrationArgs(argv: string[]): ParsedMigrationArgs {
  const [modeArg] = argv;
  if (modeArg !== "export" && modeArg !== "import") {
    throw new Error("first argument must be export or import");
  }

  const valueFor = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };

  return {
    mode: modeArg,
    execute: argv.includes("--execute"),
    approval: valueFor("--approval"),
    bucket: valueFor("--bucket"),
    object: valueFor("--object"),
  };
}

export function assertExecutionApproval(args: ParsedMigrationArgs): void {
  if (!args.execute) return;
  const expected =
    args.mode === "export" ? EXPORT_APPROVAL : IMPORT_APPROVAL;
  if (args.approval !== expected) {
    throw new Error(
      `${args.mode} execution requires --approval ${expected}`,
    );
  }
}

export function assertStorageCoordinates(
  bucket: string | null,
  object: string | null,
): asserts bucket is string {
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("a valid --bucket is required");
  }
  if (
    !object ||
    object.startsWith("/") ||
    object.includes("..") ||
    !/^[A-Za-z0-9/_\-.]{1,512}$/.test(object)
  ) {
    throw new Error("a safe relative --object is required");
  }
}

export function assertExecutionBoundary(
  mode: MigrationMode,
  projectId: string,
  databaseName: string,
): void {
  const expected =
    mode === "export"
      ? { project: SOURCE_PROJECT, database: SOURCE_DATABASE }
      : { project: TARGET_PROJECT, database: TARGET_DATABASE };
  if (projectId !== expected.project || databaseName !== expected.database) {
    throw new Error(
      `${mode} boundary mismatch: expected project ${expected.project} database ${expected.database}`,
    );
  }
}

export function decodeMigrationKey(value: string | undefined): Buffer {
  if (!value) throw new Error("AOA_MIGRATION_KEY_B64 is required");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("AOA_MIGRATION_KEY_B64 must decode to exactly 32 bytes");
  }
  return key;
}

export function validateExpectedRows(
  tables: Partial<Record<MigrationTableKey, TableArchive>>,
): void {
  for (const spec of MIGRATION_TABLES) {
    const key = tableKey(spec);
    const table = tables[key];
    if (!table) throw new Error(`archive is missing ${key}`);
    if (table.rows !== spec.expectedRows) {
      throw new Error(
        `${key} count changed: expected ${spec.expectedRows}, received ${table.rows}`,
      );
    }
    const payload = Buffer.from(table.payloadBase64, "base64");
    if (sha256(payload) !== table.payloadSha256) {
      throw new Error(`${key} payload digest mismatch`);
    }
    const rows = JSON.parse(payload.toString("utf8")) as unknown;
    if (!Array.isArray(rows) || rows.length !== table.rows) {
      throw new Error(`${key} payload row count mismatch`);
    }
  }
}

export function validateArchive(value: unknown): LegacyDevArchive {
  if (!value || typeof value !== "object") {
    throw new Error("archive must be an object");
  }
  const archive = value as LegacyDevArchive;
  if (
    archive.formatVersion !== ARCHIVE_FORMAT_VERSION ||
    archive.sourceProject !== SOURCE_PROJECT ||
    archive.sourceDatabase !== SOURCE_DATABASE ||
    !Array.isArray(archive.sourceMigrations) ||
    typeof archive.schemaSignature !== "string" ||
    !archive.tables
  ) {
    throw new Error("archive header is invalid");
  }
  validateExpectedRows(archive.tables);
  return archive;
}

export function encryptArchive(
  archive: LegacyDevArchive,
  key: Buffer,
  iv = randomBytes(12),
): EncryptedArchive {
  if (key.length !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  if (iv.length !== 12) throw new Error("AES-GCM IV must be 12 bytes");
  validateArchive(archive);

  const plaintext = Buffer.from(JSON.stringify(archive), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(ARCHIVE_AAD, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    cipher: "aes-256-gcm",
    archiveSha256: sha256(plaintext),
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
  };
}

export function decryptArchive(
  envelope: EncryptedArchive,
  key: Buffer,
): LegacyDevArchive {
  if (
    envelope.formatVersion !== ARCHIVE_FORMAT_VERSION ||
    envelope.cipher !== "aes-256-gcm"
  ) {
    throw new Error("encrypted archive header is invalid");
  }
  const iv = Buffer.from(envelope.ivBase64, "base64");
  const authTag = Buffer.from(envelope.authTagBase64, "base64");
  if (iv.length !== 12) throw new Error("AES-GCM IV must be 12 bytes");
  if (authTag.length !== GCM_AUTH_TAG_BYTES) {
    throw new Error(
      `AES-GCM authentication tag must be ${GCM_AUTH_TAG_BYTES} bytes`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(ARCHIVE_AAD, "utf8"));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextBase64, "base64")),
    decipher.final(),
  ]);
  if (sha256(plaintext) !== envelope.archiveSha256) {
    throw new Error("archive digest mismatch");
  }
  return validateArchive(JSON.parse(plaintext.toString("utf8")));
}

export function archiveSummary(archive: LegacyDevArchive) {
  return {
    formatVersion: archive.formatVersion,
    archiveCreatedAt: archive.createdAt,
    sourceMigrationCount: archive.sourceMigrations.length,
    schemaSignature: archive.schemaSignature,
    rows: Object.fromEntries(
      MIGRATION_TABLES.map((spec) => [
        tableKey(spec),
        archive.tables[tableKey(spec)].rows,
      ]),
    ),
  };
}

export function payloadJson(table: TableArchive): string {
  const payload = Buffer.from(table.payloadBase64, "base64");
  if (sha256(payload) !== table.payloadSha256) {
    throw new Error("table payload digest mismatch");
  }
  return payload.toString("utf8");
}

export function digestText(value: string): string {
  return sha256(value);
}
