import { describe, expect, it } from "vitest";
import {
  archiveSummary,
  assertExecutionApproval,
  assertExecutionBoundary,
  assertStorageCoordinates,
  decodeMigrationKey,
  decryptArchive,
  encryptArchive,
  EXPORT_APPROVAL,
  IMPORT_APPROVAL,
  MIGRATION_TABLES,
  parseMigrationArgs,
  tableKey,
  validateArchive,
  type LegacyDevArchive,
  type MigrationTableKey,
  type TableArchive,
} from "@/lib/migrations/legacy-dev-data";
import { createHash } from "node:crypto";

const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

function fixtureArchive(): LegacyDevArchive {
  const tables = Object.fromEntries(
    MIGRATION_TABLES.map((spec) => {
      const payload = Buffer.from(
        JSON.stringify(
          Array.from({ length: spec.expectedRows }, (_, index) => ({
            id: `${tableKey(spec)}-${index}`,
          })),
        ),
        "utf8",
      );
      return [
        tableKey(spec),
        {
          rows: spec.expectedRows,
          payloadBase64: payload.toString("base64"),
          payloadSha256: digest(payload),
        } satisfies TableArchive,
      ];
    }),
  ) as Record<MigrationTableKey, TableArchive>;

  return {
    formatVersion: 1,
    createdAt: "2026-07-30T12:00:00.000Z",
    sourceProject: "ops-portal",
    sourceDatabase: "aoa_dev",
    sourceMigrations: ["20260629221157_init"],
    schemaSignature: "schema-digest",
    tables,
  };
}

describe("legacy dev migration argument gates", () => {
  it("keeps dry-run as the default", () => {
    expect(parseMigrationArgs(["export"])).toEqual({
      mode: "export",
      execute: false,
      approval: null,
      bucket: null,
      object: null,
    });
    expect(() =>
      assertExecutionApproval(parseMigrationArgs(["import"])),
    ).not.toThrow();
  });

  it("requires a mode-specific approval phrase for every live action", () => {
    expect(() =>
      assertExecutionApproval(
        parseMigrationArgs(["export", "--execute", "--approval", "wrong"]),
      ),
    ).toThrow(`--approval ${EXPORT_APPROVAL}`);
    expect(() =>
      assertExecutionApproval(
        parseMigrationArgs([
          "import",
          "--execute",
          "--approval",
          IMPORT_APPROVAL,
        ]),
      ),
    ).not.toThrow();
  });

  it("pins export and import to the intended project and database", () => {
    expect(() =>
      assertExecutionBoundary("export", "ops-portal", "aoa_dev"),
    ).not.toThrow();
    expect(() =>
      assertExecutionBoundary("import", "ops-portal-dev", "aoa"),
    ).not.toThrow();
    expect(() =>
      assertExecutionBoundary("import", "ops-portal", "aoa"),
    ).toThrow(/boundary mismatch/);
  });

  it("rejects unsafe staging coordinates", () => {
    expect(() =>
      assertStorageCoordinates("aoa-migration-123", "legacy/archive.enc"),
    ).not.toThrow();
    expect(() =>
      assertStorageCoordinates("Bad Bucket", "legacy/archive.enc"),
    ).toThrow(/bucket/);
    expect(() =>
      assertStorageCoordinates("aoa-migration-123", "../archive.enc"),
    ).toThrow(/object/);
  });
});

describe("legacy dev encrypted archive", () => {
  it("round-trips with AES-256-GCM and exposes only a digest", () => {
    const archive = fixtureArchive();
    const key = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 3);
    const envelope = encryptArchive(archive, key, iv);

    expect(envelope.cipher).toBe("aes-256-gcm");
    expect(envelope.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(envelope)).not.toContain("app.deal-0");
    expect(decryptArchive(envelope, key)).toEqual(archive);
  });

  it("fails closed when ciphertext is changed", () => {
    const envelope = encryptArchive(
      fixtureArchive(),
      Buffer.alloc(32, 9),
      Buffer.alloc(12, 4),
    );
    const ciphertext = Buffer.from(envelope.ciphertextBase64, "base64");
    ciphertext[0] ^= 1;

    expect(() =>
      decryptArchive(
        {
          ...envelope,
          ciphertextBase64: ciphertext.toString("base64"),
        },
        Buffer.alloc(32, 9),
      ),
    ).toThrow();
  });

  it("rejects a truncated AES-GCM authentication tag", () => {
    const key = Buffer.alloc(32, 2);
    const envelope = encryptArchive(
      fixtureArchive(),
      key,
      Buffer.alloc(12, 8),
    );
    const authTag = Buffer.from(envelope.authTagBase64, "base64");

    expect(() =>
      decryptArchive(
        {
          ...envelope,
          authTagBase64: authTag.subarray(0, 12).toString("base64"),
        },
        key,
      ),
    ).toThrow(/authentication tag must be 16 bytes/);
  });

  it("rejects a source count change before upload or import", () => {
    const archive = fixtureArchive();
    archive.tables["app.deal"] = {
      ...archive.tables["app.deal"],
      rows: 285,
    };
    expect(() => validateArchive(archive)).toThrow(
      /app\.deal count changed/,
    );
  });

  it("decodes only 256-bit keys and reports a counts-only summary", () => {
    const key = Buffer.alloc(32, 5).toString("base64");
    expect(decodeMigrationKey(key)).toHaveLength(32);
    expect(() =>
      decodeMigrationKey(Buffer.alloc(31).toString("base64")),
    ).toThrow(/32 bytes/);

    const summary = archiveSummary(fixtureArchive());
    expect(summary.rows["app.deal"]).toBe(286);
    expect(JSON.stringify(summary)).not.toContain("app.deal-0");
  });
});
