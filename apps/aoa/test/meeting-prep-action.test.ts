import { beforeEach, describe, expect, it, vi } from "vitest";

// generateMeetingPrep — the ONE write path for AI meeting prep. Same mock idiom
// as the transfer action tests: `@/auth`, `@/lib/rls`, `@/lib/flags`, the data
// seam and Next's cache/navigation are mocked so the Server Action imports
// cleanly in the node env, and withUserScope runs the real callback against a
// fake tx whose meetingPrep.* / auditLog.create are spies.
//
// Asserts: flag OFF and VIEWER both refuse with NO appointment read, NO model
// call and NO write; a missing/past appointment refuses; the throttle refuses AT
// the cap BEFORE spending a Vertex call; a Vertex failure maps its reason through
// and writes nothing; the happy path upserts + audits in ONE tx with a PII-free
// detail whose entityId is the row cuid, never the appointment key.

const {
  authSpy,
  withUserScopeSpy,
  flagSpy,
  revalidateSpy,
  redirectSpy,
  getAppointmentSpy,
  gatherSpy,
  readPrepSpy,
  upsertSpy,
  draftSpy,
  findForSaveSpy,
  setSavedSpy,
} = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  flagSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  redirectSpy: vi.fn(),
  getAppointmentSpy: vi.fn(),
  gatherSpy: vi.fn(),
  readPrepSpy: vi.fn(),
  upsertSpy: vi.fn(),
  draftSpy: vi.fn(),
  findForSaveSpy: vi.fn(),
  setSavedSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
// PARTIAL mock of @/lib/flags — the action only reads aiMeetingPrepEnabled, but
// anything it grows must be listed here or the call throws "not a function".
vi.mock("@/lib/flags", () => ({ aiMeetingPrepEnabled: flagSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));
vi.mock("@/lib/data/meeting-prep", () => ({
  getAppointmentByKey: getAppointmentSpy,
  gatherMeetingPrepSources: gatherSpy,
  readMeetingPrep: readPrepSpy,
  upsertMeetingPrep: upsertSpy,
  findMeetingPrepForSave: findForSaveSpy,
  setMeetingPrepSaved: setSavedSpy,
}));
vi.mock("@/lib/ai/draft", () => ({ draftCommunication: draftSpy }));

import {
  generateMeetingPrep,
  saveMeetingPrepToPortrait,
  unsaveMeetingPrepFromPortrait,
} from "@/app/(authenticated)/command-center/actions";
import {
  MEETING_PREP_GENERATE,
  MEETING_PREP_SAVE,
  MEETING_PREP_UNSAVE,
} from "@/lib/audit";
import { MEETING_PREP_GENERATION_CAP } from "@/lib/data/meeting-prep-view";
import { AiError } from "@/lib/ai/gemini";

const KEY = "slack-appointments-feed|stone family trust|2026-08-01T14:00:00.000Z";
const ROW_ID = "cmeetingprep0000000000001";
const SAVED_AT = new Date("2026-07-27T15:00:00.000Z");

const APPOINTMENT = {
  externalKey: KEY,
  clientName: "Stone Family Trust",
  clientSfId: "003AAA",
  advisorName: "Mason O'Reilly",
  meetingType: "Quarterly review",
  startsAt: new Date(Date.now() + 86_400_000), // tomorrow
};

const SOURCES = {
  meeting: {
    clientName: "Stone Family Trust",
    advisorName: "Mason O'Reilly",
    meetingType: "Quarterly review",
    when: "Tomorrow · 10:30 AM ET",
  },
  client: {
    name: "Sam Stone",
    householdName: "Stone Household",
    householdStatus: "Active",
    householdStage: "Client",
    leadAdvisorEmail: "dana@example.com",
  },
  aumTotal: 2_400_000,
  accounts: [],
  deals: [],
  transfers: [],
  tasks: [],
  activity: [],
  emails: [],
};

type FakeTx = {
  meetingPrep: { findUnique: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

let tx: FakeTx;

beforeEach(() => {
  vi.clearAllMocks();
  authSpy.mockResolvedValue({
    user: { email: "ops@example.com", role: "OPERATIONS" },
  });
  flagSpy.mockReturnValue(true);
  getAppointmentSpy.mockResolvedValue(APPOINTMENT);
  gatherSpy.mockResolvedValue(SOURCES);
  readPrepSpy.mockResolvedValue(null);
  draftSpy.mockResolvedValue({
    draft: "## Snapshot\n- $2.4M across 3 accounts",
    model: "gemini-3.8-flash",
    finishReason: "STOP",
  });
  upsertSpy.mockResolvedValue({
    id: ROW_ID,
    generations: 1,
    generatedAt: new Date("2026-07-27T12:00:00.000Z"),
    savedAt: null,
  });
  findForSaveSpy.mockResolvedValue({ id: ROW_ID, clientSfId: "003AAA", savedAt: null });
  setSavedSpy.mockResolvedValue({ id: ROW_ID, savedAt: SAVED_AT });
  tx = {
    meetingPrep: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (t: FakeTx) => Promise<unknown>) => fn(tx),
  );
});

describe("generateMeetingPrep — gates", () => {
  it("refuses when AI_MEETING_PREP is OFF, without reading or calling anything", async () => {
    flagSpy.mockReturnValue(false);
    expect(await generateMeetingPrep(KEY)).toEqual({ ok: false, reason: "flag_off" });
    expect(getAppointmentSpy).not.toHaveBeenCalled();
    expect(draftSpy).not.toHaveBeenCalled();
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("refuses a VIEWER (SC-7) — no model call, no write", async () => {
    authSpy.mockResolvedValue({ user: { email: "v@x.com", role: "VIEWER" } });
    expect(await generateMeetingPrep(KEY)).toEqual({
      ok: false,
      reason: "not_authorized",
    });
    expect(getAppointmentSpy).not.toHaveBeenCalled();
    expect(draftSpy).not.toHaveBeenCalled();
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown role (fail closed)", async () => {
    authSpy.mockResolvedValue({ user: { email: "x@x.com" } });
    expect(await generateMeetingPrep(KEY)).toEqual({
      ok: false,
      reason: "not_authorized",
    });
  });

  it("allows each of the four current write roles through to the model", async () => {
    for (const role of [
      "ADMIN",
      "OPERATIONS",
      "ADVISOR",
      "CLIENT_SERVICE",
    ]) {
      authSpy.mockResolvedValue({ user: { email: "a@x.com", role } });
      const res = await generateMeetingPrep(KEY);
      expect(res.ok, role).toBe(true);
    }
  });

  it("refuses when the appointment is gone from the feed", async () => {
    getAppointmentSpy.mockResolvedValue(null);
    expect(await generateMeetingPrep(KEY)).toEqual({ ok: false, reason: "not_found" });
    expect(draftSpy).not.toHaveBeenCalled();
  });

  it("refuses a meeting that already happened", async () => {
    getAppointmentSpy.mockResolvedValue({
      ...APPOINTMENT,
      startsAt: new Date(Date.now() - 3_600_000),
    });
    expect(await generateMeetingPrep(KEY)).toEqual({
      ok: false,
      reason: "past_meeting",
    });
    expect(draftSpy).not.toHaveBeenCalled();
  });
});

describe("generateMeetingPrep — regeneration throttle", () => {
  const brief = (generations: number) => ({
    id: ROW_ID,
    brief: {
      text: "old",
      generatedAt: new Date(),
      model: "gemini-3.8-flash",
      finishReason: "STOP",
      truncated: false,
      generations,
      generatedBy: "ops@example.com",
      savedAt: null,
    },
  });

  it("allows a regenerate below the cap", async () => {
    readPrepSpy.mockResolvedValue(brief(MEETING_PREP_GENERATION_CAP - 1));
    const res = await generateMeetingPrep(KEY);
    expect(res.ok).toBe(true);
    expect(draftSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses AT the cap BEFORE spending a Vertex call, and writes nothing", async () => {
    readPrepSpy.mockResolvedValue(brief(MEETING_PREP_GENERATION_CAP));
    expect(await generateMeetingPrep(KEY)).toEqual({ ok: false, reason: "throttled" });
    expect(draftSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses OVER the cap too", async () => {
    readPrepSpy.mockResolvedValue(brief(MEETING_PREP_GENERATION_CAP + 3));
    expect(await generateMeetingPrep(KEY)).toEqual({ ok: false, reason: "throttled" });
    expect(draftSpy).not.toHaveBeenCalled();
  });

  it("re-checks inside the transaction, so a concurrent generate cannot exceed the cap", async () => {
    // The pre-check saw a fresh row; by the time the tx opened, another request
    // had already pushed it to the cap.
    readPrepSpy.mockResolvedValue(brief(1));
    tx.meetingPrep.findUnique.mockResolvedValue({
      generations: MEETING_PREP_GENERATION_CAP,
    });
    expect(await generateMeetingPrep(KEY)).toEqual({ ok: false, reason: "throttled" });
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });
});

describe("generateMeetingPrep — model failures", () => {
  it.each([
    ["config_error"],
    ["unauthorized"],
    ["model_not_found"],
    ["rate_limited"],
    ["upstream_error"],
    ["transport_error"],
    ["empty_response"],
  ] as const)("maps AiError %s through and writes nothing (SC-8/SC-9)", async (reason) => {
    draftSpy.mockRejectedValue(new AiError("boom", reason));
    expect(await generateMeetingPrep(KEY)).toEqual({ ok: false, reason });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("maps a non-AiError throw to a generic upstream failure (no message leak)", async () => {
    draftSpy.mockRejectedValue(new Error("postgres said: relation does not exist"));
    const res = await generateMeetingPrep(KEY);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
    expect(JSON.stringify(res)).not.toContain("postgres");
  });

  it("returns write_failed when the transaction is rejected (e.g. RLS)", async () => {
    withUserScopeSpy.mockRejectedValue(new Error("permission denied for table"));
    const res = await generateMeetingPrep(KEY);
    expect(res).toEqual({ ok: false, reason: "write_failed" });
    expect(JSON.stringify(res)).not.toContain("permission denied");
  });
});

describe("generateMeetingPrep — the happy path", () => {
  it("calls the engine with the meeting_prep kind and 3072 output tokens", async () => {
    await generateMeetingPrep(KEY);
    const arg = draftSpy.mock.calls[0]![0];
    expect(arg.kind).toBe("meeting_prep");
    expect(arg.tone).toBe("concise");
    expect(arg.maxOutputTokens).toBe(3072);
    expect(arg.context).toContain("=== MEETING ===");
  });

  it("upserts the brief and audits it in the SAME transaction", async () => {
    const res = await generateMeetingPrep(KEY);
    expect(res.ok).toBe(true);
    expect(withUserScopeSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0]![0]).toBe(tx); // the caller's tx, shared
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(revalidateSpy).toHaveBeenCalledWith("/command-center");
  });

  it("returns the brief the panel renders", async () => {
    const res = await generateMeetingPrep(KEY);
    expect(res).toEqual({
      ok: true,
      brief: {
        text: "## Snapshot\n- $2.4M across 3 accounts",
        generatedAt: new Date("2026-07-27T12:00:00.000Z"),
        model: "gemini-3.8-flash",
        finishReason: "STOP",
        truncated: false,
        generations: 1,
        generatedBy: "ops@example.com",
        savedAt: null,
      },
    });
  });

  it("REGENERATING an already-saved brief keeps it attached to the portrait", async () => {
    tx.meetingPrep.findUnique.mockResolvedValue({ generations: 2 });
    upsertSpy.mockResolvedValue({
      id: ROW_ID,
      generations: 3,
      generatedAt: new Date("2026-07-27T13:00:00.000Z"),
      savedAt: SAVED_AT,
    });
    const res = await generateMeetingPrep(KEY);
    expect(res.ok && res.brief.savedAt).toEqual(SAVED_AT);
  });

  it("writes an audit row with NO PII — entityId is the row cuid, never the key (SC-6)", async () => {
    await generateMeetingPrep(KEY);
    const entry = tx.auditLog.create.mock.calls[0]![0].data;
    expect(entry.action).toBe(MEETING_PREP_GENERATE);
    expect(entry.entityType).toBe("meeting_prep");
    expect(entry.entityId).toBe(ROW_ID);
    // The appointment key embeds the client name — it must never be the id.
    expect(entry.entityId).not.toContain("|");
    expect(entry.entityId).not.toContain("Stone");

    const detail = JSON.parse(entry.detail as string);
    expect(detail).toMatchObject({
      clientSfId: "003AAA",
      model: "gemini-3.8-flash",
      finishReason: "STOP",
      regenerated: false,
      generations: 1,
      cap: MEETING_PREP_GENERATION_CAP,
      truncated: false,
    });
    expect(detail.sources).toEqual({
      accounts: 0,
      deals: 0,
      transfers: 0,
      tasks: 0,
      activity: 0,
      emails: 0,
    });
    // No brief text, no prompt, no names, no account numbers anywhere.
    const serialized = entry.detail as string;
    expect(serialized).not.toContain("Snapshot");
    expect(serialized).not.toContain("Stone");
    expect(serialized).not.toContain("Mason O'Reilly");
    expect(serialized).not.toContain("=== MEETING ===");
  });

  it("marks a regenerate as such in the audit detail (SC-5)", async () => {
    tx.meetingPrep.findUnique.mockResolvedValue({ generations: 2 });
    upsertSpy.mockResolvedValue({
      id: ROW_ID,
      generations: 3,
      generatedAt: new Date("2026-07-27T13:00:00.000Z"),
    });
    await generateMeetingPrep(KEY);
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0]![0].data.detail as string);
    expect(detail.regenerated).toBe(true);
    expect(detail.generations).toBe(3);
  });

  it("still generates for an appointment with NO linked client (SC-3)", async () => {
    getAppointmentSpy.mockResolvedValue({ ...APPOINTMENT, clientSfId: null });
    gatherSpy.mockResolvedValue({ ...SOURCES, client: null, aumTotal: null });
    const res = await generateMeetingPrep(KEY);
    expect(res.ok).toBe(true);
    const arg = draftSpy.mock.calls[0]![0];
    expect(arg.context).toContain("no linked client record");
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0]![0].data.detail as string);
    expect(detail.clientSfId).toBeNull();
  });
});

// --- Save to / remove from the Client Portrait -------------------------------
// The owner ask (2026-07-27): "make the save … button work — Save saves to
// client portrait". The brief is ALREADY persisted, so these only flip
// saved_at / saved_by. Asserts the same gate order as generate, the
// no-client-link refusal (the unlinked-appointment path), idempotent re-save,
// and a PII-free audit row whose entityId is the row cuid.

describe("saveMeetingPrepToPortrait — gates", () => {
  it("refuses when AI_MEETING_PREP is OFF, without touching the DB", async () => {
    flagSpy.mockReturnValue(false);
    expect(await saveMeetingPrepToPortrait(KEY)).toEqual({
      ok: false,
      reason: "flag_off",
    });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(setSavedSpy).not.toHaveBeenCalled();
  });

  it("refuses a VIEWER — no read, no write", async () => {
    authSpy.mockResolvedValue({ user: { email: "v@x.com", role: "VIEWER" } });
    expect(await saveMeetingPrepToPortrait(KEY)).toEqual({
      ok: false,
      reason: "not_authorized",
    });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown role (fail closed)", async () => {
    authSpy.mockResolvedValue({ user: { email: "x@x.com" } });
    expect(await saveMeetingPrepToPortrait(KEY)).toEqual({
      ok: false,
      reason: "not_authorized",
    });
    expect(setSavedSpy).not.toHaveBeenCalled();
  });

  it("allows each of the four current write roles", async () => {
    for (const role of [
      "ADMIN",
      "OPERATIONS",
      "ADVISOR",
      "CLIENT_SERVICE",
    ]) {
      authSpy.mockResolvedValue({ user: { email: "a@x.com", role } });
      expect((await saveMeetingPrepToPortrait(KEY)).ok, role).toBe(true);
    }
  });

  it("refuses when there is no stored brief for that key", async () => {
    findForSaveSpy.mockResolvedValue(null);
    expect(await saveMeetingPrepToPortrait(KEY)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(setSavedSpy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses a brief whose appointment has NO linked client — nothing to attach to", async () => {
    findForSaveSpy.mockResolvedValue({ id: ROW_ID, clientSfId: null, savedAt: null });
    expect(await saveMeetingPrepToPortrait(KEY)).toEqual({
      ok: false,
      reason: "no_client_link",
    });
    expect(setSavedSpy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("returns write_failed when the transaction is rejected (e.g. RLS), with no message leak", async () => {
    withUserScopeSpy.mockRejectedValue(new Error("permission denied for table"));
    const res = await saveMeetingPrepToPortrait(KEY);
    expect(res).toEqual({ ok: false, reason: "write_failed" });
    expect(JSON.stringify(res)).not.toContain("permission denied");
  });
});

describe("saveMeetingPrepToPortrait — the write", () => {
  it("stamps saved_at/saved_by and audits it in the SAME transaction", async () => {
    const res = await saveMeetingPrepToPortrait(KEY);
    expect(res).toEqual({ ok: true, savedAt: SAVED_AT });
    expect(withUserScopeSpy).toHaveBeenCalledTimes(1);
    expect(setSavedSpy).toHaveBeenCalledTimes(1);
    expect(setSavedSpy.mock.calls[0]![0]).toBe(tx); // the caller's tx, shared
    expect(setSavedSpy.mock.calls[0]![1]).toEqual({
      appointmentKey: KEY,
      saved: true,
      savedBy: "ops@example.com",
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("revalidates BOTH the command center and the client's portrait", async () => {
    await saveMeetingPrepToPortrait(KEY);
    expect(revalidateSpy).toHaveBeenCalledWith("/command-center");
    expect(revalidateSpy).toHaveBeenCalledWith("/client-portrait/003AAA");
  });

  it("is IDEMPOTENT — a second save UPDATEs the same row and never inserts", async () => {
    // Already attached: the row comes back with a saved_at.
    findForSaveSpy.mockResolvedValue({
      id: ROW_ID,
      clientSfId: "003AAA",
      savedAt: new Date("2026-07-27T09:00:00.000Z"),
    });
    const res = await saveMeetingPrepToPortrait(KEY);
    expect(res).toEqual({ ok: true, savedAt: SAVED_AT });
    // One UPDATE, one audit row — no create path exists on this action at all.
    expect(setSavedSpy).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0]![0].data.detail as string);
    expect(detail.resaved).toBe(true);
  });

  it("writes an audit row with NO PII — entityId is the row cuid, never the key", async () => {
    await saveMeetingPrepToPortrait(KEY);
    const entry = tx.auditLog.create.mock.calls[0]![0].data;
    expect(entry.action).toBe(MEETING_PREP_SAVE);
    expect(entry.entityType).toBe("meeting_prep");
    expect(entry.entityId).toBe(ROW_ID);
    expect(entry.entityId).not.toContain("|");
    expect(entry.entityId).not.toContain("stone");
    expect(JSON.parse(entry.detail as string)).toEqual({
      clientSfId: "003AAA",
      resaved: false,
    });
    // No brief text, no client/advisor name, no appointment key.
    const serialized = entry.detail as string;
    expect(serialized).not.toContain("Snapshot");
    expect(serialized).not.toContain("Stone");
    expect(serialized).not.toContain("stone");
    expect(serialized).not.toContain("Mason O'Reilly");
  });
});

describe("unsaveMeetingPrepFromPortrait", () => {
  it("nulls the stamp — an UPDATE, never a delete", async () => {
    setSavedSpy.mockResolvedValue({ id: ROW_ID, savedAt: null });
    findForSaveSpy.mockResolvedValue({
      id: ROW_ID,
      clientSfId: "003AAA",
      savedAt: SAVED_AT,
    });
    expect(await unsaveMeetingPrepFromPortrait(KEY)).toEqual({ ok: true, savedAt: null });
    expect(setSavedSpy.mock.calls[0]![1]).toEqual({
      appointmentKey: KEY,
      saved: false,
      savedBy: null,
    });
  });

  it("audits the detach with its own action and a PII-free detail", async () => {
    setSavedSpy.mockResolvedValue({ id: ROW_ID, savedAt: null });
    await unsaveMeetingPrepFromPortrait(KEY);
    const entry = tx.auditLog.create.mock.calls[0]![0].data;
    expect(entry.action).toBe(MEETING_PREP_UNSAVE);
    expect(entry.entityId).toBe(ROW_ID);
    expect(JSON.parse(entry.detail as string)).toEqual({ clientSfId: "003AAA" });
  });

  it("is allowed even for a brief with no linked client (detaching is always safe)", async () => {
    findForSaveSpy.mockResolvedValue({ id: ROW_ID, clientSfId: null, savedAt: SAVED_AT });
    setSavedSpy.mockResolvedValue({ id: ROW_ID, savedAt: null });
    expect((await unsaveMeetingPrepFromPortrait(KEY)).ok).toBe(true);
    // No portrait path to revalidate when there is no client.
    expect(revalidateSpy).toHaveBeenCalledWith("/command-center");
    expect(revalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a VIEWER and the OFF flag, like save", async () => {
    flagSpy.mockReturnValue(false);
    expect(await unsaveMeetingPrepFromPortrait(KEY)).toEqual({
      ok: false,
      reason: "flag_off",
    });
    flagSpy.mockReturnValue(true);
    authSpy.mockResolvedValue({ user: { email: "v@x.com", role: "VIEWER" } });
    expect(await unsaveMeetingPrepFromPortrait(KEY)).toEqual({
      ok: false,
      reason: "not_authorized",
    });
    expect(setSavedSpy).not.toHaveBeenCalled();
  });
});
