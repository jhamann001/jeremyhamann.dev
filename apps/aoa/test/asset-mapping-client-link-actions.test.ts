import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  edits: vi.fn(),
  linking: vi.fn(),
  scope: vi.fn(),
  audit: vi.fn(),
  baseUrl: vi.fn(),
  send: vi.fn(),
  writeThrough: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ GoogleAuth: vi.fn(function () { return { getIdTokenClient: vi.fn() }; }) }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({
  assetMappingReadEnabled: m.read,
  assetMappingEditsEnabled: m.edits,
  assetMappingClientLinkingEnabled: m.linking,
}));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/data/asset-map-write-through", () => ({ writeThroughAssetMapEdit: m.writeThrough }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  writeAudit: m.audit,
}));
vi.mock("@/lib/data/asset-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/asset-map")>()),
  assetMapBaseUrl: m.baseUrl,
  sendAssetMapClientLink: m.send,
}));

import {
  applyClientLink,
  loadClientLinkBatch,
  loadClientLinkConfig,
  loadClientLinkQueue,
  loadRunClientLink,
  previewClientLink,
  previewClientLinkRevert,
  retryClientLinkLookup,
  searchClientDirectory,
} from "@/app/(authenticated)/asset-mapping/actions";
import type { ClientLinkDraft } from "@/lib/data/asset-map-client-link-contract";

const BASE = "https://pipeline.example.test";
const RUN = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const PREVIEW_ID = "33333333-3333-4333-8333-333333333333";
const tx = { synthetic: "tx" };
const FORBIDDEN = { ok: false, reason: "forbidden", message: null };
const REJECTED = { ok: false, reason: "rejected", message: null };
const QUEUE = { q: "", reviewState: null, cursor: null, limit: 50 };

const CONFIRM: ClientLinkDraft = {
  action: "confirm", run_id: RUN, target_scope: "this_run", expected_identity_version: 0,
  people_ids: ["synthetic-person-1"], coverage: "complete", primary_user_id: "synthetic-person-1",
};

function folderTargets(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    source_scope: { source_system: "google_drive" as const, source_folder_id: `synthetic-folder-${i}` },
    expected_revision: 0,
  }));
}

function backfill(n: number): ClientLinkDraft {
  return { action: "backfill", target_scope: "bulk", folder_targets: folderTargets(n) };
}

const PREVIEW_BODY = {
  preview_id: PREVIEW_ID, kind: "confirm", payload_hash: "synthetic-hash", expires_at: "2026-10-04T12:00:00Z",
  acknowledgement: "Synthetic acknowledgement.", targets: [{ run_id: RUN }], exclusions: [],
};
const BATCH_BODY = { batch_id: BATCH, applied: 2, unchanged: 1, excluded: 0, kind: "confirm" };
const RUN_BODY = { run_id: RUN, identity: { people: [] }, events: [] };

function signIn(role: string) {
  m.auth.mockResolvedValue({ user: { role, email: "synthetic@example.invalid" } });
}

function allNine() {
  return Promise.all([
    loadClientLinkConfig(),
    loadClientLinkQueue(QUEUE),
    loadRunClientLink(RUN),
    searchClientDirectory("synthetic"),
    previewClientLink(CONFIRM),
    applyClientLink(PREVIEW_ID, "synthetic-hash", true),
    retryClientLinkLookup(RUN),
    loadClientLinkBatch(BATCH),
    previewClientLinkRevert(BATCH),
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  m.read.mockReturnValue(true);
  m.edits.mockReturnValue(true);
  m.linking.mockReturnValue(true);
  signIn("OPERATIONS");
  m.baseUrl.mockReturnValue(BASE);
  m.send.mockResolvedValue({ ok: true, body: {} });
  m.scope.mockImplementation(async (_identity, callback) => callback(tx));
});

describe("client-link server actions", () => {
  it("returns forbidden for every client-link action when the flag is off", async () => {
    m.linking.mockReturnValue(false);
    expect(await allNine()).toEqual(Array(9).fill(FORBIDDEN));
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects VIEWER on every client-link action", async () => {
    signIn("VIEWER");
    expect(await allNine()).toEqual(Array(9).fill(FORBIDDEN));
    expect(m.send).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE"])("rejects %s on every operate action before any pipeline call (ticket)", async (role) => {
    signIn(role);
    const results = await Promise.all([
      searchClientDirectory("synthetic"),
      previewClientLink(CONFIRM),
      previewClientLink(backfill(1)),
      applyClientLink(PREVIEW_ID, "synthetic-hash", true),
      retryClientLinkLookup(RUN),
      loadClientLinkBatch(BATCH),
      previewClientLinkRevert(BATCH),
    ]);
    expect(results).toEqual(Array(7).fill(FORBIDDEN));
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE"])("lets %s read the config, queue and a redacted run, as statement-pipeline `advisor` (ticket)", async (role) => {
    signIn(role);
    const run = {
      run_id: RUN,
      identity: { people: [{ user_id: "synthetic-person-1", display_name: "Synthetic Person" }] },
      lookup: { state: "ready", suggestion: { synthetic: "suggestion" }, directory: { synthetic: "directory" }, error_code: null, message: null },
      holder_evidence: ["Synthetic Holder"],
      folder: null,
      events: [{ synthetic: "event" }],
      identity_version: 2,
      source_scope: null,
    };
    m.send
      .mockResolvedValueOnce({ ok: true, body: { client_linking_enabled: true, client_linking_writes_enabled: true } })
      .mockResolvedValueOnce({ ok: true, body: { items: [], total: 0, next_cursor: null } })
      .mockResolvedValueOnce({ ok: true, body: run });
    const [config, queue, read] = [await loadClientLinkConfig(), await loadClientLinkQueue(QUEUE), await loadRunClientLink(RUN)];
    expect(config.ok && queue.ok).toBe(true);
    expect(read).toEqual({
      ok: true,
      data: {
        ...run,
        events: [],
        holder_evidence: [],
        lookup: { state: "ready", suggestion: null, directory: null, error_code: null, message: null },
      },
    });
    expect(m.send.mock.calls.map((c) => c[1].kind)).toEqual(["config", "queue", "run"]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("returns the run unredacted to OPERATIONS", async () => {
    const run = { ...RUN_BODY, holder_evidence: ["Synthetic Holder"], lookup: { state: "ready", suggestion: { s: 1 }, directory: { d: 1 } }, events: [{ e: 1 }] };
    m.send.mockResolvedValueOnce({ ok: true, body: run });
    expect(await loadRunClientLink(RUN)).toEqual({ ok: true, data: run });
  });

  it("loads the config, queue, run, search, and batch without an audit row", async () => {
    m.send
      .mockResolvedValueOnce({ ok: true, body: { client_linking_enabled: true, client_linking_writes_enabled: true } })
      .mockResolvedValueOnce({ ok: true, body: { items: [], total: 0, next_cursor: null } })
      .mockResolvedValueOnce({ ok: true, body: RUN_BODY })
      .mockResolvedValueOnce({ ok: true, body: { candidates: [], directory: null, lookup_state: "ready", message: null } })
      .mockResolvedValueOnce({ ok: true, body: BATCH_BODY });
    const results = [
      await loadClientLinkConfig(),
      await loadClientLinkQueue(QUEUE),
      await loadRunClientLink(RUN),
      await searchClientDirectory("  synthetic  "),
      await loadClientLinkBatch(BATCH),
    ];
    expect(results.every((r) => r.ok)).toBe(true);
    expect(m.send.mock.calls.map((c) => c[1].kind)).toEqual(["config", "queue", "run", "search", "batch"]);
    expect(m.send.mock.calls[3][1]).toEqual({ kind: "search", q: "synthetic" });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects a draft with more than 20 people before any pipeline call", async () => {
    const people = Array.from({ length: 21 }, (_, i) => `synthetic-person-${i}`);
    expect(await previewClientLink({ ...CONFIRM, people_ids: people, primary_user_id: people[0] })).toEqual(REJECTED);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("rejects a backfill with more than 100 folders before any pipeline call", async () => {
    expect(await previewClientLink(backfill(101))).toEqual(REJECTED);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("accepts a backfill of exactly 100 folders", async () => {
    m.send.mockResolvedValue({ ok: true, body: { ...PREVIEW_BODY, kind: "backfill" } });
    const result = await previewClientLink(backfill(100));
    expect(result.ok).toBe(true);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][2].detail).toEqual({ kind: "backfill", targets: 1, exclusions: 0, folders: 100 });
  });

  it("rejects invalid run and batch ids before any pipeline call", async () => {
    const results = await Promise.all([
      loadRunClientLink("not-a-run"),
      retryClientLinkLookup("../x"),
      loadClientLinkBatch(""),
      previewClientLinkRevert("not-a-batch"),
      previewClientLink({ ...CONFIRM, run_id: "not-a-run" }),
    ]);
    expect(results).toEqual(Array(5).fill(REJECTED));
    expect(m.send).not.toHaveBeenCalled();
  });

  it("rejects apply without acknowledgement before any pipeline call", async () => {
    expect(await applyClientLink(PREVIEW_ID, "synthetic-hash", false)).toEqual(REJECTED);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("writes one audit row under the signed-in operator after a confirmed preview", async () => {
    m.send.mockResolvedValue({ ok: true, body: PREVIEW_BODY });
    const result = await previewClientLink(CONFIRM);
    expect(result).toEqual({ ok: true, data: PREVIEW_BODY });
    expect(m.audit).toHaveBeenCalledTimes(1);
    const identity = { role: "OPERATIONS", email: "synthetic@example.invalid" };
    expect(m.scope.mock.calls[0][0]).toEqual(identity);
    expect(m.audit).toHaveBeenCalledWith(tx, identity, {
      action: "asset_map_client_link.preview",
      entityType: "asset_map_client_link_preview",
      entityId: PREVIEW_ID,
      detail: { kind: "confirm", targets: 1, exclusions: 0, folders: 0 },
    });
  });

  it("writes one audit row with batch counts after a confirmed apply", async () => {
    m.send.mockResolvedValue({ ok: true, body: BATCH_BODY });
    await applyClientLink(PREVIEW_ID, "synthetic-hash", true);
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][2]).toEqual({
      action: "asset_map_client_link.apply",
      entityType: "asset_map_client_link_batch",
      entityId: BATCH,
      detail: { kind: "confirm", applied: 2, unchanged: 1, excluded: 0 },
    });
  });

  it("writes one audit row after a lookup retry and after a revert preview", async () => {
    m.send.mockResolvedValueOnce({ ok: true, body: { run: RUN_BODY, accepted: true } });
    await retryClientLinkLookup(RUN);
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][2]).toEqual({
      action: "asset_map_client_link.lookup_retry", entityType: "asset_map_household", entityId: RUN, detail: { accepted: true },
    });
    m.send.mockResolvedValueOnce({ ok: true, body: { ...PREVIEW_BODY, kind: "revert", reverts_batch_id: BATCH } });
    await previewClientLinkRevert(BATCH);
    expect(m.audit).toHaveBeenCalledTimes(2);
    expect(m.audit.mock.calls[1][2]).toEqual({
      action: "asset_map_client_link.revert_preview",
      entityType: "asset_map_client_link_preview",
      entityId: PREVIEW_ID,
      detail: { revertsBatchId: BATCH, targets: 1 },
    });
  });

  it("writes no audit row when the pipeline refuses", async () => {
    for (const reason of ["rejected", "stale", "writes_disabled", "unavailable"] as const) {
      m.send.mockResolvedValueOnce({ ok: false, reason, message: "Synthetic refusal." });
      expect(await previewClientLink(CONFIRM)).toEqual({ ok: false, reason, message: "Synthetic refusal." });
    }
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("returns unavailable when the base URL is unset", async () => {
    m.baseUrl.mockReturnValue(null);
    expect(await loadClientLinkConfig()).toEqual({ ok: false, reason: "unavailable", message: null });
    expect(m.send).not.toHaveBeenCalled();
  });

  it("returns unavailable for a malformed pipeline body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.send.mockResolvedValue({ ok: true, body: { preview_id: PREVIEW_ID } });
    expect(await previewClientLink(CONFIRM)).toEqual({ ok: false, reason: "unavailable", message: null });
    m.send.mockResolvedValue({ ok: true, body: "<html>" });
    expect(await loadClientLinkQueue(QUEUE)).toEqual({ ok: false, reason: "unavailable", message: null });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("never writes to the mirror", async () => {
    m.send.mockImplementation(async (_base, req: { kind: string }) => {
      const bodies: Record<string, unknown> = {
        config: {},
        queue: { items: [], total: 0, next_cursor: null },
        run: RUN_BODY,
        search: { candidates: [] },
        preview: PREVIEW_BODY,
        apply: BATCH_BODY,
        retry: { run: RUN_BODY, accepted: true },
        batch: BATCH_BODY,
        revertPreview: PREVIEW_BODY,
      };
      return { ok: true, body: bodies[req.kind] };
    });
    const results = await allNine();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(m.writeThrough).not.toHaveBeenCalled();
  });

  it("sends the same idempotency key when the same apply is retried", async () => {
    m.send.mockResolvedValueOnce({ ok: false, reason: "unavailable", message: null });
    m.send.mockResolvedValueOnce({ ok: true, body: BATCH_BODY });
    await applyClientLink(PREVIEW_ID, "synthetic-hash", true);
    await applyClientLink(PREVIEW_ID, "synthetic-hash", true);
    const [first, second] = m.send.mock.calls.map((c) => c[1].idempotencyKey);
    expect(first).toHaveLength(68);
    expect(second).toBe(first);
  });

  it("returns only enabled and writesEnabled from the config body", async () => {
    m.send.mockResolvedValueOnce({
      ok: true,
      body: { google_client_id: "synthetic", client_linking_enabled: true, client_linking_writes_enabled: false },
    });
    expect(await loadClientLinkConfig()).toEqual({ ok: true, data: { enabled: true, writesEnabled: false } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.send.mockResolvedValueOnce({ ok: true, body: ["synthetic"] });
    expect(await loadClientLinkConfig()).toEqual({ ok: false, reason: "unavailable", message: null });
  });
});
