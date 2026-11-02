import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), stale: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale }));

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import { GET, POST } from "@/app/api/acat-security-recon/[id]/route";
import { GET as ACCOUNTS } from "@/app/api/acat-security-recon/[id]/accounts/route";

const SUITE = "acat-security-recon-route";
const BASE = "https://transfers.jeremyhamann.dev";
const RECON_PATH = "/api/machine/acats/by-record/rec-1/security-recon";
const ALL_ON: Record<string, string> = {
  EPIC_ACAT_OPS_WORKSPACE_TKT290: "1",
  SHOW_ACAT_OPS_BOOK_TKT293: "1",
  ALLOW_ACAT_OPS_EDITS_TKT294: "1",
  EPIC_ACAT_TRANSFER_DRAWER_TKT319: "1",
  SHOW_ACAT_TRANSFER_DRAWER_TKT332: "1",
  EPIC_ACAT_SECURITY_RECON_TKT320: "1",
  SHOW_ACAT_SECURITY_RECON_TKT334: "1",
};

function enable(over: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...ALL_ON, ...over })) vi.stubEnv(key, value);
}

const MAPPING = {
  mappingTransferStatus: "Transferable", mappingTransferNotes: null, mappingTransferring: true,
  mappingStatementDate: "2026-09-30", mappingStatementAgeDays: 12, mappingStatementIsStale: false,
  mappingSyncedAt: "2026-10-12T15:04:00.000Z",
};
function rawPosition(over: Record<string, unknown> = {}) {
  return {
    id: "asset-1", symbol: "VTI", description: "Vanguard Total Market", cusip: "922908769", expectedQty: 100, actualQty: 100,
    amount: 25000, assetClass: "ETF", status: "Matched", issue: null, notes: null, mapping: MAPPING, ...over,
  };
}
function rawSnapshot(over: Record<string, unknown> = {}) {
  return {
    acatId: "rec-1", mappingSource: "GCP Project API", apexSource: "Uploaded", lastSynced: "2026-10-12T15:04:00.000Z",
    sourceAccount: null, hasStatementAccount: true, positions: [rawPosition()],
    counts: { total: 1, matched: 1, issues: 0, reconRate: 100 }, ...over,
  };
}
const PREVIEW = { apexFormat: "activities", positions: [rawPosition({ id: "apex-extra-0", status: "Unexpected", expectedQty: 0 })], counts: { total: 1, matched: 0, issues: 1, reconRate: 0 } };

function tracker(status: number | null, data: unknown, refusal: string | null = null) {
  if (status === null) requestMock.mockRejectedValueOnce(new Error("socket hang up"));
  else requestMock.mockResolvedValueOnce({ status, data, headers: new Headers(refusal ? { "x-recon-refusal": refusal } : {}) });
}

const ctx = (id = "rec-1") => ({ params: Promise.resolve({ id }) });

function post(body: unknown, headers: Record<string, string> = {}, id = "rec-1") {
  const request = new Request(`http://localhost/api/acat-security-recon/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(request, ctx(id));
}
function get(headers: Record<string, string> = {}, id = "rec-1") {
  return GET(new Request(`http://localhost/api/acat-security-recon/${id}`, { headers }), ctx(id));
}
function accounts(q: string | null, headers: Record<string, string> = {}) {
  const url = `http://localhost/api/acat-security-recon/rec-1/accounts${q === null ? "" : `?q=${encodeURIComponent(q)}`}`;
  return ACCOUNTS(new Request(url, { headers }), ctx());
}

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.stale.mockReset();
  mocks.revalidate.mockReset();
  requestMock.mockReset();
  getIdTokenClientMock.mockClear();
  mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("security recon routes", () => {
  it("tkt334 route: both routes answer 404 with no tracker call while a switch is off", async () => {
    for (const off of ["EPIC_ACAT_SECURITY_RECON_TKT320", "SHOW_ACAT_SECURITY_RECON_TKT334", "SHOW_ACAT_TRANSFER_DRAWER_TKT332", "SHOW_ACAT_OPS_BOOK_TKT293"]) {
      vi.unstubAllEnvs();
      enable({ [off]: "0" });
      for (const response of [await get(), await post({ action: "refresh" }), await accounts("smith")]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
    }
    vi.unstubAllEnvs();
    for (const response of [await get(), await post({ action: "refresh" }), await accounts("smith")]) expect(response.status).toBe(404);
    expect(requestMock).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: both routes answer 404 with no tracker call while a switch is off");
  });

  it("tkt334 route: no session is 401 and a disallowed role is 403", async () => {
    enable();
    mocks.auth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await post({ action: "refresh" })).status).toBe(401);
    expect((await accounts("smith")).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { role: "VIEWER" } });
    expect((await get()).status).toBe(403);
    expect((await post({ action: "refresh" })).status).toBe(403);
    expect((await accounts("smith")).status).toBe(403);
    expect(requestMock).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: no session is 401 and a disallowed role is 403");
  });

  it("tkt334 route: a write or an account search needs the edits switch, a read does not", async () => {
    enable({ ALLOW_ACAT_OPS_EDITS_TKT294: "0" });
    expect((await post({ action: "refresh" })).status).toBe(403);
    expect((await accounts("smith")).status).toBe(403);
    expect(requestMock).not.toHaveBeenCalled();
    tracker(200, rawSnapshot());
    const read = await get();
    expect(read.status).toBe(200);
    expect(requestMock).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt334 route: a write or an account search needs the edits switch, a read does not");
  });

  it("tkt334 route: a cross-site request and a non-json post are refused", async () => {
    enable();
    expect((await get({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ action: "refresh" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await accounts("smith", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const form = new Request("http://localhost/api/acat-security-recon/rec-1", {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ action: "refresh" }),
    });
    expect((await POST(form, ctx())).status).toBe(415);
    expect(requestMock).not.toHaveBeenCalled();
    tracker(200, rawSnapshot());
    expect((await get({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    markCase(SUITE, "tkt334 route: a cross-site request and a non-json post are refused");
  });

  it("tkt334 route: a bad record id is 404", async () => {
    enable();
    for (const id of ["bad id!", "a/b", "x".repeat(129)]) {
      expect((await get({}, id)).status).toBe(404);
      expect((await post({ action: "refresh" }, {}, id)).status).toBe(404);
    }
    expect(requestMock).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: a bad record id is 404");
  });

  it("tkt334 route: the envelope carries ok with snapshot, refused with status message and snapshot, and failure with reason and retryable", async () => {
    enable();
    tracker(200, rawSnapshot());
    const ok = await (await post({ action: "refresh" })).json();
    expect(Object.keys(ok).sort()).toEqual(["ok", "snapshot"]);
    expect(ok.ok).toBe(true);
    tracker(200, { ...rawSnapshot(), preview: PREVIEW });
    const withPreview = await (await post({ action: "upload", kind: "apex", filename: "a.csv", text: "x" })).json();
    expect(Object.keys(withPreview).sort()).toEqual(["ok", "preview", "snapshot"]);
    tracker(422, rawSnapshot(), "Mapping CSV must be 2 MB or smaller.");
    const refused = await post({ action: "upload", kind: "mapping", filename: "m.csv", text: "x" });
    expect(refused.status).toBe(200);
    const refusedBody = await refused.json();
    expect(Object.keys(refusedBody).sort()).toEqual(["message", "ok", "refused", "snapshot", "status"]);
    expect(refusedBody).toMatchObject({ ok: false, refused: true, status: 422, message: "Mapping CSV must be 2 MB or smaller." });
    tracker(500, { error: "internal_error" });
    const failed = await post({ action: "refresh" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ ok: false, refused: false, reason: "Security reconciliation is unavailable — try again.", retryable: true });
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
    markCase(SUITE, "tkt334 route: the envelope carries ok with snapshot, refused with status message and snapshot, and failure with reason and retryable");
  });

  it("tkt334 route: GET returns the stored snapshot", async () => {
    enable();
    tracker(200, rawSnapshot());
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.snapshot.positions).toHaveLength(1);
    expect(body.snapshot.counts).toEqual({ total: 1, matched: 1, issues: 0, reconRate: 100 });
    expect(body).not.toHaveProperty("preview");
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ url: `${BASE}${RECON_PATH}`, method: "GET", timeout: 12_000 }));
    expect(mocks.stale).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: GET returns the stored snapshot");
  });

  it("tkt334 route: GET maps a tracker 404 to a final failure and a 500 or no answer to a retryable one", async () => {
    enable();
    tracker(404, { error: "not_found" });
    const missing = await get();
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual({ ok: false, refused: false, reason: "This transfer was not found.", retryable: false });
    tracker(500, { error: "internal_error" });
    const broken = await get();
    expect(broken.status).toBe(502);
    expect(await broken.json()).toMatchObject({ ok: false, refused: false, retryable: true, reason: "Could not load security reconciliation." });
    tracker(null, null);
    const silent = await get();
    expect(silent.status).toBe(502);
    expect(await silent.json()).toMatchObject({ retryable: true });
    tracker(200, { not: "a snapshot" });
    expect((await get()).status).toBe(502);
    markCase(SUITE, "tkt334 route: GET maps a tracker 404 to a final failure and a 500 or no answer to a retryable one");
  });

  it("tkt334 route: a refresh returns the snapshot and marks the book stale", async () => {
    enable();
    tracker(200, rawSnapshot({ lastSynced: "2026-10-13T12:00:00.000Z" }));
    const response = await post({ action: "refresh", sourceAccountId: "2f1d3b5e-6a4c-4a1b-9c3d-0e1f2a3b4c5d" });
    expect(response.status).toBe(200);
    expect((await response.json()).snapshot.lastSynced).toBe("2026-10-13T12:00:00.000Z");
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      url: `${BASE}${RECON_PATH}`, method: "POST", timeout: 55_000,
      data: { action: "refresh", sourceAccountId: "2f1d3b5e-6a4c-4a1b-9c3d-0e1f2a3b4c5d" },
    }));
    expect(mocks.stale).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledWith("/acat-tracking");
    markCase(SUITE, "tkt334 route: a refresh returns the snapshot and marks the book stale");
  });

  it("tkt334 route: a refused refresh returns the stored snapshot with the tracker message and does not mark stale", async () => {
    enable();
    const message = "This account is not available in asset mapping. Choose a mapping account, verify the statement number, or upload the mapping CSV.";
    tracker(404, rawSnapshot(), message);
    const response = await post({ action: "refresh" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, refused: true, status: 404, message });
    expect(body.snapshot.positions[0].id).toBe("asset-1");
    expect(mocks.stale).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: a refused refresh returns the stored snapshot with the tracker message and does not mark stale");
  });

  it("tkt334 route: an Apex upload returns a preview and does not mark stale", async () => {
    enable();
    tracker(200, { ...rawSnapshot(), preview: PREVIEW });
    const response = await post({ action: "upload", kind: "apex", filename: "activities.csv", text: "a,b\n1,2" });
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.preview.apexFormat).toBe("activities");
    expect(body.preview.positions[0].status).toBe("Unexpected");
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST", timeout: 40_000, data: { action: "upload", kind: "apex", filename: "activities.csv", text: "a,b\n1,2" },
    }));
    expect(mocks.stale).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: an Apex upload returns a preview and does not mark stale");
  });

  it("tkt334 route: a mapping upload is stored and marks stale", async () => {
    enable();
    tracker(200, rawSnapshot({ mappingSource: "Spreadsheet Upload" }));
    const response = await post({ action: "upload", kind: "mapping", filename: "map.csv", text: "Account Number,Symbol\n1,VTI" });
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.snapshot.mappingSource).toBe("Spreadsheet Upload");
    expect(body).not.toHaveProperty("preview");
    expect(mocks.stale).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt334 route: a mapping upload is stored and marks stale");
  });

  it("tkt334 route: a save returns the stored counts", async () => {
    enable();
    tracker(200, rawSnapshot({ counts: { total: 3, matched: 2, issues: 1, reconRate: 67 } }));
    const row = { id: "asset-1", symbol: "VTI", description: "Vanguard", cusip: null, actualQty: 90, amount: null, assetClass: null, status: "Mismatch", issue: "Qty Mismatch", notes: null, expectedQty: 100, mapping: {} };
    const response = await post({ action: "save", rows: [row], apexUploaded: true, overriddenIds: ["asset-1"] });
    const body = await response.json();
    expect(body.snapshot.counts).toEqual({ total: 3, matched: 2, issues: 1, reconRate: 67 });
    const sent = requestMock.mock.calls[0][0].data;
    expect(sent.rows[0]).not.toHaveProperty("expectedQty");
    expect(sent).toMatchObject({ action: "save", apexUploaded: true, overriddenIds: ["asset-1"] });
    expect(sent.rows[0]).toMatchObject({ id: "asset-1", actualQty: 90, status: "Mismatch" });
    expect(mocks.stale).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt334 route: a save returns the stored counts");
  });

  it("tkt334 route: an invalid body is 400 with no tracker call", async () => {
    enable();
    const bad: unknown[] = [
      "not json",
      {},
      { action: "delete" },
      { action: "upload", kind: "other", filename: "a.csv", text: "x" },
      { action: "upload", kind: "apex", filename: "", text: "x" },
      { action: "refresh", sourceAccountId: "not-a-uuid" },
      { action: "save", rows: [{ id: "a", symbol: "X", description: "", actualQty: 1, status: "Mapped" }], apexUploaded: false, overriddenIds: [] },
      { action: "save", rows: [{ id: "a", symbol: "X", description: "", actualQty: Number.POSITIVE_INFINITY, status: "Matched" }], apexUploaded: false, overriddenIds: [] },
      { action: "save", rows: Array.from({ length: 501 }, (_, i) => ({ id: `a${i}`, symbol: "X", description: "", actualQty: 1, status: "Matched" })), apexUploaded: false, overriddenIds: [] },
    ];
    for (const body of bad) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, refused: false, reason: "Invalid security reconciliation request", retryable: false });
    }
    expect(requestMock).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: an invalid body is 400 with no tracker call");
  });

  it("tkt334 route: an oversized body is 413 by content-length and by streamed length when content-length is missing or understated, with no tracker call", async () => {
    enable();
    const oversized = JSON.stringify({ action: "upload", kind: "apex", filename: "a.csv", text: "x".repeat(6_000_100) });
    const declared = await post(oversized, { "content-length": String(oversized.length) });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ ok: false, refused: false, retryable: false });

    const chunk = new TextEncoder().encode("y".repeat(1_000_000));
    function stream(chunks: number) {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= chunks) controller.close();
          else { sent += 1; controller.enqueue(chunk); }
        },
      });
    }
    const missing = new Request("http://localhost/api/acat-security-recon/rec-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: stream(8), duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await POST(missing, ctx())).status).toBe(413);
    const understated = new Request("http://localhost/api/acat-security-recon/rec-1", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "12" }, body: stream(8), duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await POST(understated, ctx())).status).toBe(413);
    expect(requestMock).not.toHaveBeenCalled();
    tracker(200, rawSnapshot());
    const justUnder = JSON.stringify({ action: "upload", kind: "apex", filename: "a.csv", text: "x".repeat(4_900_000) });
    expect((await post(justUnder)).status).toBe(200);
    markCase(SUITE, "tkt334 route: an oversized body is 413 by content-length and by streamed length when content-length is missing or understated, with no tracker call");
  });

  it("tkt334 route: a tracker 500, 401, or 429 is an opaque failure with no positions", async () => {
    enable();
    const cases: [number, boolean][] = [[500, true], [401, false], [429, true]];
    for (const [status, retryable] of cases) {
      tracker(status, status === 500 ? rawSnapshot() : { error: "x" });
      const response = await post({ action: "refresh" });
      const text = await response.text();
      expect(response.status).toBe(retryable ? 502 : 422);
      expect(text).not.toContain("positions");
      expect(text).not.toContain("snapshot");
      expect(JSON.parse(text)).toMatchObject({ ok: false, refused: false, retryable });
    }
    tracker(500, rawSnapshot(), "tracker failure text must not surface");
    const withHeader = await (await post({ action: "refresh" })).text();
    expect(withHeader).not.toContain("tracker failure text");
    expect(withHeader).not.toContain("positions");
    expect(mocks.stale).not.toHaveBeenCalled();
    markCase(SUITE, "tkt334 route: a tracker 500, 401, or 429 is an opaque failure with no positions");
  });

  it("tkt334 route: a 404 without the refusal header is a failure, not a refusal", async () => {
    enable();
    tracker(404, { error: "not_found" });
    const missing = await (await post({ action: "refresh" })).json();
    expect(missing).toMatchObject({ ok: false, refused: false });
    expect(missing).not.toHaveProperty("snapshot");
    tracker(404, rawSnapshot());
    const noHeader = await (await post({ action: "refresh" })).json();
    expect(noHeader).toMatchObject({ ok: false, refused: false });
    expect(noHeader).not.toHaveProperty("snapshot");
    markCase(SUITE, "tkt334 route: a 404 without the refusal header is a failure, not a refusal");
  });

  it("tkt334 route: account search validates the query and returns parsed accounts", async () => {
    enable();
    for (const q of [null, "", "a", " a ", "x".repeat(101)]) {
      const response = await accounts(q);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, reason: "Enter a client name or account number (2–100 characters).", retryable: false });
    }
    expect(requestMock).not.toHaveBeenCalled();
    tracker(200, {
      accounts: [{ id: "src-1", clientName: "Pat Example", holder: "Pat Example", custodian: "Fidelity", registration: "Individual", accountNumberLast4: "4321", investorNumberLast4: null, statementDate: "2026-09-30", isHistorical: false, positionCount: 3 }, { nope: 1 }],
      truncated: true,
    });
    const response = await accounts("  Example ");
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, truncated: true, accounts: [{ id: "src-1", positionCount: 3 }] });
    expect(body.accounts).toHaveLength(1);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      url: `${BASE}${RECON_PATH}/accounts?q=Example`, method: "GET", timeout: 15_000,
    }));
    markCase(SUITE, "tkt334 route: account search validates the query and returns parsed accounts");
  });

  it("tkt334 route: account search failures carry the tracker message or a retryable failure", async () => {
    enable();
    tracker(502, { error: "Unable to search mapping accounts. Please try again." });
    const upstream = await accounts("smith");
    expect(upstream.status).toBe(502);
    expect(await upstream.json()).toEqual({ ok: false, reason: "Unable to search mapping accounts. Please try again.", retryable: true });
    tracker(503, { error: "Asset mapping is not configured." });
    expect(await (await accounts("smith")).json()).toMatchObject({ reason: "Asset mapping is not configured.", retryable: true });
    tracker(400, { error: "Enter a client name or account number (2–100 characters)." });
    const rejected = await accounts("smith");
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ retryable: false });
    tracker(500, { error: "internal_error" });
    expect(await (await accounts("smith")).json()).toEqual({ ok: false, reason: "Unable to load mapping accounts. Try searching again.", retryable: true });
    tracker(null, null);
    expect((await accounts("smith")).status).toBe(502);
    markCase(SUITE, "tkt334 route: account search failures carry the tracker message or a retryable failure");
  });
});
