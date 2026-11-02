import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  isReadOperation,
  isTransientConnectionError,
  operationIsInTransaction,
  runWithConnectionRetry,
} from "@/lib/db";

// ticket (resilience half). On Cloud Run, an idle instance's Prisma→Cloud SQL
// sockets go stale; the first request after idle fails with a transient
// connection error (P1001 / P1017). Because that first failure happens inside
// the Auth.js session lookup, an un-retried drop logs the user out to Okta.
// `runWithConnectionRetry` (lib/db.ts) retries such an op ONCE after a reconnect
// — but ONLY for non-transactional, transient-connection failures, and NEVER
// inside a transaction (retrying a single op there would run outside the SET
// LOCAL RLS scope in lib/rls.ts). These tests pin all three safety boundaries
// without a live DB.

// A P1001 raised against an already-initialised engine surfaces as a
// KnownRequestError (`.code`); on (re)connect it surfaces as an
// InitializationError (`.errorCode`). We exercise both shapes.
function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`engine error ${code}`, {
    code,
    clientVersion: "6.19.3",
  });
}
function initError(errorCode: string): Prisma.PrismaClientInitializationError {
  return new Prisma.PrismaClientInitializationError(
    `can't reach database (${errorCode})`,
    "6.19.3",
    errorCode,
  );
}

describe("isTransientConnectionError", () => {
  it("matches P1001 / P1017 on both Prisma error classes", () => {
    expect(isTransientConnectionError(knownError("P1001"))).toBe(true);
    expect(isTransientConnectionError(knownError("P1017"))).toBe(true);
    // P1001 on (re)connect arrives as an InitializationError with `.errorCode`.
    expect(isTransientConnectionError(initError("P1001"))).toBe(true);
    expect(isTransientConnectionError(initError("P1017"))).toBe(true);
  });

  it("does NOT match non-connection errors (constraint / validation / plain)", () => {
    expect(isTransientConnectionError(knownError("P2002"))).toBe(false); // unique constraint
    expect(isTransientConnectionError(knownError("P2025"))).toBe(false); // record not found
    expect(isTransientConnectionError(initError("P1000"))).toBe(false); // auth failed
    expect(isTransientConnectionError(new Error("boom"))).toBe(false);
    expect(isTransientConnectionError({ code: "P1001" })).toBe(false); // not a Prisma error instance
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});

describe("isReadOperation (retry is gated to idempotent reads)", () => {
  it("matches every read operation", () => {
    for (const op of [
      "findUnique",
      "findUniqueOrThrow",
      "findFirst",
      "findFirstOrThrow",
      "findMany",
      "count",
      "aggregate",
      "groupBy",
    ]) {
      expect(isReadOperation(op)).toBe(true);
    }
  });

  it("does NOT match writes or raw ops (they must run exactly once — P1017 double-apply risk)", () => {
    for (const op of [
      "create",
      "createMany",
      "update",
      "updateMany",
      "upsert",
      "delete",
      "deleteMany",
      "$executeRaw",
      "$executeRawUnsafe",
      "$queryRaw",
      "$queryRawUnsafe",
    ]) {
      expect(isReadOperation(op)).toBe(false);
    }
  });
});

describe("operationIsInTransaction (Prisma __internalParams tag)", () => {
  it("is true for interactive (itx) and batch transaction ops", () => {
    expect(
      operationIsInTransaction({ __internalParams: { transaction: { kind: "itx" } } }),
    ).toBe(true);
    expect(
      operationIsInTransaction({ __internalParams: { transaction: { kind: "batch" } } }),
    ).toBe(true);
  });

  it("is false for a top-level op (transaction present-but-undefined) and tolerates a missing field", () => {
    expect(
      operationIsInTransaction({ __internalParams: { transaction: undefined } }),
    ).toBe(false);
    // Missing __internalParams entirely → false (never throws in the hot path);
    // the DB-gated integration test guards the live-runtime field name instead.
    expect(operationIsInTransaction({})).toBe(false);
    expect(operationIsInTransaction(null)).toBe(false);
  });
});

describe("runWithConnectionRetry (top-level, non-transactional)", () => {
  it("(a) P1001 then success → returns the success value after ONE reconnect + ONE retry", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(knownError("P1001"))
      .mockResolvedValueOnce("ok");
    const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const result = await runWithConnectionRetry(run, false, reconnect);

    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2); // original + one retry
    expect(reconnect).toHaveBeenCalledTimes(1); // reconnect before the retry
  });

  it("also recovers from the P1001 InitializationError shape (the prod symptom)", async () => {
    const run = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(initError("P1001"))
      .mockResolvedValueOnce(42);
    const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(runWithConnectionRetry(run, false, reconnect)).resolves.toBe(
      42,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("(b) a non-connection error (P2002) is NOT retried and propagates unchanged", async () => {
    const err = knownError("P2002");
    const run = vi.fn<() => Promise<never>>().mockRejectedValue(err);
    const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(runWithConnectionRetry(run, false, reconnect)).rejects.toBe(
      err, // same instance, same type — behaviour preserved exactly
    );
    expect(run).toHaveBeenCalledTimes(1); // no retry
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("retries at most ONCE — a second transient failure propagates (no loop)", async () => {
    const second = knownError("P1017");
    const run = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(knownError("P1001"))
      .mockRejectedValueOnce(second);
    const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(runWithConnectionRetry(run, false, reconnect)).rejects.toBe(
      second,
    );
    expect(run).toHaveBeenCalledTimes(2); // original + exactly one retry
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not touch the happy path (no reconnect, single call)", async () => {
    const run = vi.fn<() => Promise<string>>().mockResolvedValue("fast");
    const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(runWithConnectionRetry(run, false, reconnect)).resolves.toBe(
      "fast",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });
});

describe("runWithConnectionRetry (transaction safety)", () => {
  it("(c) a connection error inside a transaction is NOT retried — it propagates so the aborted tx (and its RLS scope) is not silently re-run outside scope", async () => {
    // `inTransaction: true` models an op running via the withUserScope() `tx`
    // client. Even a transient P1001 must NOT be retried here: the surrounding
    // interactive transaction is already aborted, and a lone retry would execute
    // OUTSIDE the SET LOCAL app.user_role / app.user_email GUCs — breaking RLS.
    const err = knownError("P1001");
    const run = vi.fn<() => Promise<never>>().mockRejectedValue(err);
    const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(runWithConnectionRetry(run, true, reconnect)).rejects.toBe(
      err,
    );
    expect(run).toHaveBeenCalledTimes(1); // ran once, no retry
    expect(reconnect).not.toHaveBeenCalled(); // never reconnected mid-tx
  });

  it("passes a transactional success straight through, exactly once", async () => {
    const run = vi.fn<() => Promise<string>>().mockResolvedValue("tx-ok");
    const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(runWithConnectionRetry(run, true, reconnect)).resolves.toBe(
      "tx-ok",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });
});
