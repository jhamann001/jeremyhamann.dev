import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/zendesk-tickets/route";
import * as scope from "../../lib/ingest/scope";

const TOKEN = "test-zendesk-ingest-token";

function ticket(over: Record<string, unknown> = {}) {
  return {
    zendesk_ticket_id: "40290",
    requester_id: "12345",
    requester_cedar_ridge_user_id: "user-00000000-0000-0000-0000-000000000001",
    requester_email: "client@example.com",
    subject: "Account question",
    description: "Initial request",
    status: "open",
    priority: "normal",
    ticket_type: "question",
    ticket_url: "https://example.zendesk.com/agent/tickets/40290",
    created_at: "2026-08-28T12:00:00Z",
    updated_at: "2026-08-28T13:00:00Z",
    comments_truncated: false,
    comments: [{
      zendesk_comment_id: "90001",
      author_id: "12345",
      public: true,
      body: "Please help with this account.",
      created_at: "2026-08-28T12:00:00Z",
    }],
    ...over,
  };
}

function post(body: unknown, opts: { auth?: string; omitAuth?: boolean } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (!opts.omitAuth) headers.set("authorization", opts.auth ?? `Bearer ${TOKEN}`);
  return new Request("https://ops-portal.test/api/ingest/zendesk-tickets", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/ingest/zendesk-tickets", () => {
  const original = process.env.INGEST_TOKEN;
  beforeEach(() => { process.env.INGEST_TOKEN = TOKEN; });
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
  });

  it("fails closed without the bearer token", async () => {
    const response = await route.POST(post(
      { source: "zendesk", run_id: "r", items: [] },
      { omitAuth: true },
    ));
    expect(response.status).toBe(401);
  });

  it("upserts ticket content and public comments with counts-only audit detail", async () => {
    const execute = vi.fn(async () => 1);
    const auditCreate = vi.fn(async (_args: unknown) => undefined);
    vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => fn({
      $queryRaw: vi.fn(async () => [{
        match_method: "CEDAR_RIDGE_USER_ID",
        client_sf_id: "003288867315530AAA",
        household_sf_id: "001288867315530AAA",
      }]),
      $executeRaw: execute,
      auditLog: { create: auditCreate },
    } as never));

    const response = await route.POST(post({
      source: "zendesk",
      run_id: "zendesk-100",
      items: [ticket()],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      upserted: 1,
      rejected: [],
      run_id: "zendesk-100",
      linkage: {
        CEDAR_RIDGE_USER_ID: 1,
        EMAIL: 0,
        UNMATCHED: 0,
        AMBIGUOUS: 0,
      },
      public_comments: 1,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const auditArgs = auditCreate.mock.calls[0]?.[0] as { data?: { detail?: unknown } };
    const detail = JSON.stringify(auditArgs?.data?.detail ?? {});
    expect(detail).not.toContain("client@example.com");
    expect(detail).not.toContain("Please help");
  });

  it("rejects private notes without echoing their content", async () => {
    const auditCreate = vi.fn(async (_args: unknown) => undefined);
    vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => fn({
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      auditLog: { create: auditCreate },
    } as never));
    const response = await route.POST(post({
      source: "zendesk",
      run_id: "zendesk-private",
      items: [ticket({ comments: [{
        zendesk_comment_id: "90002",
        author_id: "999",
        public: false,
        body: "private note content",
        created_at: "2026-08-28T12:05:00Z",
      }] })],
    }));
    const body = await response.json();
    expect(body.rejected).toEqual([{ index: 0, reason: "comments_invalid" }]);
    expect(JSON.stringify(body)).not.toContain("private note content");
  });

  it("logs no request-controlled value when the ingest transaction fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(scope, "withIngestScope").mockRejectedValue(new Error("database unavailable"));
    const maliciousRunId = "attacker\nforged-log-entry";

    const response = await route.POST(post({
      source: "zendesk",
      run_id: maliciousRunId,
      items: [ticket()],
    }));

    expect(response.status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith("[ingest] zendesk-tickets tx_failed");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(maliciousRunId);
  });
});
