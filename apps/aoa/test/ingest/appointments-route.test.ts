import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/ingest/appointments — auth, digest selection, full-replace, dry-run — with
// the DB + audit mocked. The real parser (parseAppointmentDigest/etWallClockToUtc)
// runs. server-only stubbed; @/lib/rls stubbed (pulled in transitively by the
// appointments module the route imports).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));

const { requireIngestTokenSpy, withIngestScopeSpy, execSpy, querySpy, writeAuditSpy } = vi.hoisted(() => ({
  requireIngestTokenSpy: vi.fn(() => ({ ok: true }) as { ok: boolean }),
  withIngestScopeSpy: vi.fn(),
  execSpy: vi.fn(async (..._a: unknown[]) => 0),
  querySpy: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  writeAuditSpy: vi.fn(async () => {}),
}));
vi.mock("@/lib/ingest/auth", () => ({ requireIngestToken: requireIngestTokenSpy }));
vi.mock("@/lib/ingest/scope", () => ({
  withIngestScope: withIngestScopeSpy.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $executeRaw: execSpy, $queryRaw: querySpy }),
  ),
}));
vi.mock("@/lib/audit", () => ({ INGEST_APPOINTMENTS: "ingest.appointments", writeAudit: writeAuditSpy }));

import { GET, POST } from "@/app/api/ingest/appointments/route";

const DIGEST = `:date: *Upcoming Appointments*

*1.* Cedar Ridge Wealth - Private Wealth Consultation
:bust_in_silhouette: *Client:* Skyla Bahringer
:office_worker: *Advisor:* Rachel Moss
:date: *Date:* 07/22/2026
:clock1: *Time (EST):* 11:00 AM

---

*2.* Cedar Ridge Wealth - Private Wealth Consultation
:bust_in_silhouette: *Client:* Mylene Reichert-Bailey
:office_worker: *Advisor:* Rachel Moss
:date: *Date:* 07/23/2026
:clock1: *Time (EST):* 10:30 AM
`;

function post(body: unknown, qs = ""): Request {
  return new Request(`http://x/api/ingest/appointments${qs}`, {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireIngestTokenSpy.mockReturnValue({ ok: true });
  execSpy.mockClear();
  querySpy.mockReset().mockResolvedValue([]);
  withIngestScopeSpy.mockClear();
  writeAuditSpy.mockClear();
});

describe("/api/ingest/appointments", () => {
  it("GET → 405", async () => {
    expect((await GET()).status).toBe(405);
  });

  it("no token → 401, no DB touch", async () => {
    requireIngestTokenSpy.mockReturnValue({ ok: false });
    const res = await POST(post({ messages: [{ ts: "1", text: DIGEST }] }));
    expect(res.status).toBe(401);
    expect(withIngestScopeSpy).not.toHaveBeenCalled();
  });

  it("no messages → 400", async () => {
    expect((await POST(post({ source: "s" }))).status).toBe(400);
  });

  it("messages present but no valid digest → 422 no-op (never wipes)", async () => {
    const res = await POST(post({ messages: [{ ts: "1", text: "random chatter" }] }));
    expect(res.status).toBe(422);
    expect(withIngestScopeSpy).not.toHaveBeenCalled();
  });

  it("valid digest → 200, full-replace (DELETE then inserts), audited", async () => {
    const res = await POST(post({ messages: [{ ts: "1784813435.66", text: DIGEST }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ replaced: 2, source: "slack-appointments-feed", slack_ts: "1784813435.66" });
    // First write is the DELETE for the source, then one INSERT per appointment.
    const firstSql = (execSpy.mock.calls[0]![0] as unknown as TemplateStringsArray).join(" ");
    expect(firstSql).toContain("DELETE FROM mirror.appointment");
    expect(execSpy.mock.calls.length).toBe(1 + 2); // delete + 2 inserts
    expect(writeAuditSpy).toHaveBeenCalledOnce();
  });

  it("picks the LATEST digest by ts when several are sent", async () => {
    const older = DIGEST; // 2 appointments
    const newer = `:date: *Upcoming Appointments*

*1.* Cedar Ridge Wealth - Private Wealth Consultation
:bust_in_silhouette: *Client:* Solo Client
:date: *Date:* 07/25/2026
:clock1: *Time (EST):* 09:00 AM
`;
    const res = await POST(
      post({ messages: [{ ts: "100.0", text: older }, { ts: "200.0", text: newer }] }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ replaced: 1, slack_ts: "200.0" }); // newer digest wins
  });

  it("unions Calendly single-events with the digest (full-replaces all, newest ts)", async () => {
    const calendly = `:calendar: **New Appointment Scheduled**

**Client:** Wren Whitlock
**Advisor:** Rachel Moss
**Meeting Date:** July 28, 2026 at 2:00 PM EDT
**Source:** Calendly`;
    const res = await POST(
      post({ messages: [{ ts: "100.0", text: DIGEST }, { ts: "300.0", text: calendly }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replaced: 3, slack_ts: "300.0" }); // 2 digest + 1 Calendly
    expect(execSpy.mock.calls.length).toBe(1 + 3); // delete + 3 inserts
  });

  it("accepts a Calendly-only batch (no digest) → 200", async () => {
    const calendly = `:calendar: **New Appointment Scheduled**

**Client:** Lucia Alvarez
**Meeting Date:** August 5, 2026 at 2:15 PM EDT
**Source:** Calendly`;
    const res = await POST(post({ messages: [{ ts: "50.0", text: calendly }] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replaced: 1, slack_ts: "50.0" });
  });

  it("dryRun=1 → counts only, no DB writes", async () => {
    const res = await POST(post({ messages: [{ ts: "1", text: DIGEST }] }, "?dryRun=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ would_replace: 2 });
    expect(withIngestScopeSpy).not.toHaveBeenCalled();
  });
});
