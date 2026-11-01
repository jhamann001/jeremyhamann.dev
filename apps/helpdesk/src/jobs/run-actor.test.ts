/**
 * The jobs identity — unit tests, no database (§10 "S5").
 *
 * Deactivating `svc_jobs` is the ONLY lever an operator has for closing the scheduled-jobs surface:
 * `prisma/machine-users.ts` never re-enables a machine row on deploy, and the seed prints that the
 * matching surface "stays closed until an administrator re-enables it deliberately". These tests hold the
 * runtime to that sentence — a deactivated row must stop the run, not merely fail to be a person — and
 * mirror the equivalent block in `src/lib/integration-auth.test.ts` for `integrationActor`.
 *
 * `@/lib/db` is mocked around the real module so every other export (`withTx`, `publicDb`, the guards the
 * job handlers import at module scope) keeps its real value and only `prisma` is a stub. `@/lib/env` is
 * NOT mocked: the resolution rule is tested through the pure `resolveJobActorEmail`, which is the same
 * function `jobActorEmail()` calls, so nothing here depends on a process-wide environment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => ({ count: args.data.length })),
    },
  },
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, prisma: mockDb.prisma };
});

import { JOB_ACTOR_EMAIL } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { JOB_HANDLERS, jobActor, jobActorEmail, resolveJobActorEmail, runJob } from "@/jobs/run";

const SEEDED_ROW = { id: "svc_jobs", email: JOB_ACTOR_EMAIL, isActive: true };

/** The `data` of the nth audited insert. */
function auditRow(index: number): Record<string, unknown> {
  const call = mockDb.prisma.auditLog.create.mock.calls[index];
  expect(call, `no audit insert at index ${index}`).toBeDefined();
  return call[0].data;
}

function metadataOf(row: Record<string, unknown>): Record<string, unknown> {
  return row.metadata as Record<string, unknown>;
}

beforeEach(() => {
  mockDb.prisma.user.findUnique.mockReset();
  mockDb.prisma.auditLog.create.mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

describe("resolveJobActorEmail", () => {
  it("falls back to the seeded address when nothing is configured", () => {
    expect(resolveJobActorEmail(undefined)).toBe(JOB_ACTOR_EMAIL);
  });

  it("treats a blank or whitespace-only override as unset, like every other optional string", () => {
    expect(resolveJobActorEmail("")).toBe(JOB_ACTOR_EMAIL);
    expect(resolveJobActorEmail("   ")).toBe(JOB_ACTOR_EMAIL);
  });

  it("takes a configured address, trimmed", () => {
    expect(resolveJobActorEmail("  svc-jobs@desk.example  ")).toBe("svc-jobs@desk.example");
  });

  it("is what jobActorEmail() resolves for this process", () => {
    expect(jobActorEmail()).toBe(JOB_ACTOR_EMAIL);
  });
});

describe("jobActor", () => {
  it("is the seeded row with ZERO groups, and reads isActive to decide", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(SEEDED_ROW);
    await expect(jobActor()).resolves.toEqual({ id: "svc_jobs", email: JOB_ACTOR_EMAIL, groups: [] });
    expect(mockDb.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: JOB_ACTOR_EMAIL },
      select: { id: true, email: true, isActive: true },
    });
  });

  it("refuses when the row is missing (seed has not run) rather than inventing an actor", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(null);
    await expect(jobActor()).rejects.toBeInstanceOf(AppError);
    await expect(jobActor()).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("refuses a deactivated identity — the seed's promise that the surface stays closed", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue({ ...SEEDED_ROW, isActive: false });
    await expect(jobActor()).rejects.toBeInstanceOf(AppError);
    await expect(jobActor()).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("is re-read on every call, so a retired identity stops being usable immediately", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(SEEDED_ROW);
    await jobActor();
    await jobActor();
    expect(mockDb.prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("runJob with a deactivated jobs identity", () => {
  it("reports ok: false and never reaches the handler", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue({ ...SEEDED_ROW, isActive: false });
    const handler = vi.spyOn(JOB_HANDLERS, "sla-sweep");

    const result = await runJob("sla-sweep");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ name: "sla-sweep", processed: 0, skipped: 0, posted: 0 });
    expect(handler).not.toHaveBeenCalled();
    handler.mockRestore();
  });

  it("still lands one JOB_RUN row, marked failed, on the SYSTEM_ACTOR fallback", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue({ ...SEEDED_ROW, isActive: false });

    await runJob("event-alerts");

    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const row = auditRow(0);
    expect(row).toMatchObject({
      action: "JOB_RUN",
      entityType: "JOB",
      entityId: "event-alerts",
      fieldChanged: "outcome",
      newValue: "failed",
      actorId: null,
    });
    const metadata = metadataOf(row);
    expect(metadata.via).toBe("job");
    expect(metadata.jobName).toBe("event-alerts");
    expect(metadata.actorFallback).toBe("SYSTEM_ACTOR: the jobs user was not found or is deactivated");
    expect(String(metadata.error)).toContain("[INTERNAL]");
  });

  it("does not run the job when the row is missing either", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(null);
    const handler = vi.spyOn(JOB_HANDLERS, "duplicate-copy");

    const result = await runJob("duplicate-copy");

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    handler.mockRestore();
  });
});

describe("runJob with an active jobs identity", () => {
  it("runs the handler as the seeded actor and records the run as ok", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(SEEDED_ROW);
    const handler = vi
      .spyOn(JOB_HANDLERS, "sla-sweep")
      .mockResolvedValue({ processed: 3, skipped: 1, posted: 2, metadata: { phase: "unit" } });

    const result = await runJob("sla-sweep");

    expect(result).toMatchObject({ name: "sla-sweep", ok: true, processed: 3, skipped: 1, posted: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].actor).toEqual({ id: "svc_jobs", email: JOB_ACTOR_EMAIL, groups: [] });

    const row = auditRow(0);
    expect(row).toMatchObject({ action: "JOB_RUN", newValue: "ok", actorId: "svc_jobs" });
    expect(metadataOf(row).actorFallback).toBeUndefined();
    handler.mockRestore();
  });
});
