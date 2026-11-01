import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LOCAL_DOCUMENTS_DIR, createFilesystemStore } from "@/lib/storage";
import { loadObjectStore } from "@/jobs/object-store";
import {
  ATTACHMENT_COPY_SELECT,
  COMMENT_COPY_SELECT,
  DUPLICATE_COPY_CONTENT_TYPES,
  DUPLICATE_COPY_FILES,
  TICKET_COPY_SELECT,
  buildManifest,
  duplicateCopyPrefix,
  jsonReplacer,
  putCopy,
  sha256Hex,
  toNdjson,
} from "@/jobs/duplicate-copy";
import type { CopiedFile } from "@/jobs/duplicate-copy";
import type { ObjectStore } from "@/jobs/object-store";

/** A store that records what it was asked to write and reports the digest it actually stored. */
function fakeStore(overrides: Partial<ObjectStore> = {}): ObjectStore & { written: Map<string, Uint8Array> } {
  const written = new Map<string, Uint8Array>();
  const store = {
    backend: "filesystem" as const,
    written,
    signedPutUrl: vi.fn(),
    signedGetUrl: vi.fn(),
    head: vi.fn(),
    get: vi.fn(),
    put: async (key: string, body: Uint8Array) => {
      written.set(key, body);
      return { size: body.byteLength, sha256: sha256Hex(body) };
    },
    ...overrides,
  };
  return store as ObjectStore & { written: Map<string, Uint8Array> };
}

describe("duplicateCopyPrefix", () => {
  it("is YYYY/MM/DD in UTC, zero padded", () => {
    expect(duplicateCopyPrefix(new Date("2026-01-05T23:30:00.000Z"))).toBe("2026/01/05");
    expect(duplicateCopyPrefix(new Date("2026-12-31T00:00:00.000Z"))).toBe("2026/12/31");
  });

  it("does not shift across a local-time boundary", () => {
    // 23:00 US/Eastern on the 4th is 03:00 UTC on the 5th: the copy belongs to the UTC day.
    expect(duplicateCopyPrefix(new Date("2026-07-05T03:00:00.000Z"))).toBe("2026/07/05");
  });
});

describe("toNdjson", () => {
  it("writes one object per line with a trailing newline", () => {
    expect(toNdjson([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });

  it("is empty, not a bare newline, for no rows", () => {
    expect(toNdjson([])).toBe("");
  });

  it("serialises dates as ISO and bigints as decimal strings", () => {
    const line = toNdjson([{ at: new Date("2026-09-19T00:00:00.000Z"), seq: BigInt(99) }]);
    expect(line).toBe('{"at":"2026-09-19T00:00:00.000Z","seq":"99"}\n');
  });
});

describe("jsonReplacer", () => {
  it("only rewrites bigints", () => {
    expect(jsonReplacer("seq", BigInt(5))).toBe("5");
    expect(jsonReplacer("n", 5)).toBe(5);
    expect(jsonReplacer("s", "x")).toBe("x");
    expect(jsonReplacer("nil", null)).toBeNull();
  });
});

describe("the copied column sets", () => {
  it("never copy a ticket subject, description or requester contact detail", () => {
    for (const forbidden of [
      "subject",
      "description",
      "clientReference",
      "requesterName",
      "requesterEmail",
      "requesterPhone",
    ]) {
      expect(forbidden in TICKET_COPY_SELECT).toBe(false);
    }
    expect("number" in TICKET_COPY_SELECT).toBe(true);
    expect("status" in TICKET_COPY_SELECT).toBe(true);
  });

  it("never copy a comment body", () => {
    expect("body" in COMMENT_COPY_SELECT).toBe(false);
    expect("authorKind" in COMMENT_COPY_SELECT).toBe(true);
    expect("visibility" in COMMENT_COPY_SELECT).toBe(true);
  });

  it("copy the attachment digest and object key so the objects can be reconciled", () => {
    expect("sha256" in ATTACHMENT_COPY_SELECT).toBe(true);
    expect("objectKey" in ATTACHMENT_COPY_SELECT).toBe(true);
  });
});

describe("putCopy", () => {
  it("writes under the day's prefix and reports the digest of the bytes", async () => {
    const store = fakeStore();
    const file = await putCopy(store, "2026/09/19", DUPLICATE_COPY_FILES.tickets, "line\n", "application/x-ndjson", 1);
    expect(file.path).toBe("2026/09/19/tickets.ndjson");
    expect(file.bytes).toBe(5);
    expect(file.rows).toBe(1);
    expect(file.sha256).toBe(sha256Hex(new TextEncoder().encode("line\n")));
    expect(store.written.has("2026/09/19/tickets.ndjson")).toBe(true);
  });

  it("refuses a store whose stored digest does not match the bytes handed in", async () => {
    const store = fakeStore({ put: async () => ({ size: 5, sha256: "0".repeat(64) }) });
    await expect(putCopy(store, "2026/09/19", "audit-chain.csv", "line\n", "text/csv", 1)).rejects.toThrow(
      /does not match the bytes written/,
    );
  });

  it("refuses a store that reports a different size", async () => {
    const bytes = new TextEncoder().encode("line\n");
    const store = fakeStore({ put: async () => ({ size: 99, sha256: sha256Hex(bytes) }) });
    await expect(putCopy(store, "p", "f.csv", "line\n", "text/csv", 1)).rejects.toThrow(/does not match/);
  });
});

// ---------------------------------------------------------------------------
// The key shape, against the REAL store rather than a fake one.
//
// This is the regression the fake store hid: every file of a day's copy is keyed `YYYY/MM/DD/<name>.<ext>`,
// and the attachment key grammar — exactly two segments, no dots — refuses all five. With only a fake
// store in the suite, a job that could never write a byte passed its tests.
// ---------------------------------------------------------------------------

describe("putCopy against the real filesystem store", () => {
  const roots: string[] = [];

  async function documentStore() {
    const root = await mkdtemp(join(tmpdir(), "wm-duplicate-copy-"));
    roots.push(root);
    return { root, store: createFilesystemStore(root, "document") };
  }

  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("writes every file of a day's copy, and the bytes on disk are the bytes handed in", async () => {
    const { root, store } = await documentStore();
    const prefix = duplicateCopyPrefix(new Date("2026-09-19T07:15:00.000Z"));

    for (const [kind, name] of Object.entries(DUPLICATE_COPY_FILES)) {
      const body = `${kind} body\n`;
      const file = await putCopy(store, prefix, name, body, DUPLICATE_COPY_CONTENT_TYPES.json, 1);
      expect(file.path).toBe(`${prefix}/${name}`);
      expect(file.sha256).toBe(sha256Hex(new TextEncoder().encode(body)));
      // On disk, under the date-partitioned prefix — not just in a map a fake store kept.
      expect(await readFile(join(root, "2026", "09", "19", name), "utf8")).toBe(body);
      expect(new TextDecoder().decode(await store.get(file.path))).toBe(body);
    }
  });

  it("reports the stored digest and size back, so a transforming backend would be caught", async () => {
    const { store } = await documentStore();
    const body = "seq,prevHash,hash\n1,,abc\n";
    const file = await putCopy(store, "2026/09/19", DUPLICATE_COPY_FILES.audit, body, DUPLICATE_COPY_CONTENT_TYPES.csv, 1);
    const head = await store.head(file.path);
    expect(head).toEqual({ exists: true, size: file.bytes, sha256: file.sha256 });
  });

  it("is refused by a store built with the attachment key grammar — the shape of the original defect", async () => {
    const root = await mkdtemp(join(tmpdir(), "wm-duplicate-copy-attach-"));
    roots.push(root);
    const attachmentStore = createFilesystemStore(root);
    await expect(
      attachmentStore.put("2026/09/19/audit-chain.csv", new TextEncoder().encode("x"), "text/csv"),
    ).rejects.toThrow(/invalid object key/);
  });

  it("refuses a name that would escape the day's prefix, before any I/O", async () => {
    const { store } = await documentStore();
    for (const bad of ["../escape.csv", "sub/../../escape.csv", ".hidden.csv"]) {
      await expect(putCopy(store, "2026/09/19", bad, "x", "text/csv", 0)).rejects.toThrow(
        /is not a writable object key/,
      );
    }
  });

  it("every documented file name is a writable key for any date the prefix produces", async () => {
    const { store } = await documentStore();
    for (const date of ["2026/01/05", "2026/12/31", duplicateCopyPrefix(new Date())]) {
      for (const name of Object.values(DUPLICATE_COPY_FILES)) {
        await expect(putCopy(store, date, name, "x", "text/csv", 0)).resolves.toMatchObject({
          path: `${date}/${name}`,
        });
      }
    }
  });
});

describe("loadObjectStore", () => {
  const written: string[] = [];

  afterAll(async () => {
    await Promise.all(written.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds the store the job actually uses, and it accepts a date-keyed path", async () => {
    // No bucket configured ⇒ S4's filesystem backend under .local-object-copies/ (gitignored). This is
    // the production call path — `runDuplicateCopy` does exactly this — with the bucket left unset.
    const store = await loadObjectStore(undefined);
    expect(store.backend).toBe("filesystem");

    const scope = `vitest-${randomUUID().replace(/-/g, "")}`;
    written.push(join(process.cwd(), LOCAL_DOCUMENTS_DIR, scope));
    const file = await putCopy(
      store,
      `${scope}/2026/09/19`,
      DUPLICATE_COPY_FILES.manifest,
      "{}\n",
      DUPLICATE_COPY_CONTENT_TYPES.json,
      0,
    );
    expect(file.path).toBe(`${scope}/2026/09/19/manifest.json`);
    expect(new TextDecoder().decode(await store.get(file.path))).toBe("{}\n");
  });
});

describe("buildManifest", () => {
  const files: CopiedFile[] = [
    { path: "2026/09/19/tickets.ndjson", bytes: 10, sha256: "a".repeat(64), rows: 2 },
    { path: "2026/09/19/audit-chain.csv", bytes: 20, sha256: "b".repeat(64), rows: 5 },
  ];

  it("records the chain verdict alongside every file digest, in a stable order", () => {
    const manifest = buildManifest({
      now: new Date("2026-09-19T07:15:00.000Z"),
      requestId: "job-duplicate-copy-abc",
      prefix: "2026/09/19",
      ledger: { toSeq: "900", verified: true, checkedRows: 900, firstBadSeq: null, reason: "OK" },
      files,
    });
    expect(manifest.generatedAt).toBe("2026-09-19T07:15:00.000Z");
    expect(manifest.jobRequestId).toBe("job-duplicate-copy-abc");
    expect(manifest.ledger).toEqual({ toSeq: "900", verified: true, checkedRows: 900, firstBadSeq: null, reason: "OK" });
    expect(manifest.files.map((f) => f.path)).toEqual([
      "2026/09/19/audit-chain.csv",
      "2026/09/19/tickets.ndjson",
    ]);
  });

  it("carries a failed verdict rather than hiding it", () => {
    const manifest = buildManifest({
      now: new Date("2026-09-19T07:15:00.000Z"),
      requestId: "r",
      prefix: "p",
      ledger: { toSeq: "900", verified: false, checkedRows: 412, firstBadSeq: "412", reason: "HASH_MISMATCH" },
      files: [],
    });
    expect(manifest.ledger.verified).toBe(false);
    expect(manifest.ledger.firstBadSeq).toBe("412");
    expect(JSON.parse(JSON.stringify(manifest, jsonReplacer))).toMatchObject({ ledger: { reason: "HASH_MISMATCH" } });
  });

  it("does not mutate the files it was handed", () => {
    const input = [...files];
    buildManifest({
      now: new Date(),
      requestId: "r",
      prefix: "p",
      ledger: { toSeq: "0", verified: true, checkedRows: 0, firstBadSeq: null, reason: "EMPTY" },
      files: input,
    });
    expect(input[0].path).toBe("2026/09/19/tickets.ndjson");
  });
});

describe("sha256Hex", () => {
  it("is the standard lower-case hex digest", () => {
    expect(sha256Hex(new TextEncoder().encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
