// The demo's Transfer Tracker stand-in, through AoA's own readers and writers: each test calls the function the app
// calls (ServiceAuth → Google's request pipeline → the stand-in router) and checks that AoA's parsers accept what
// comes back, so a shape the real tracker would never send fails here. The store is in memory.
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  const values = {
    NEXT_PUBLIC_DEMO_MODE: "on",
    TRANSFER_TRACKER_URL: "https://transfers.jeremyhamann.dev",
    TRANSFER_LINKAGE_URL: "https://transfers.jeremyhamann.dev",
    TRANSFER_LINKAGE_ENVIRONMENT: "production",
    TRANSFER_LINKAGE_INSTALLATION_ID: "7c2e4b1a-9d3f-4e8a-b6c5-1f0d2a3e4b5c",
    AOA_TRANSFER_FORMS_ENABLED: "true",
    // The demo's production settings for the two gated readers below.
    APP_ENV: "prod",
    OPERATIONS_TOOLS: "1",
    OPERATIONS_PRODUCTION_ENABLED: "1",
    EPIC_ACAT_TRANSFER_DASHBOARD_TKT314: "1",
    SHOW_ACAT_TRANSFER_DASHBOARD_TKT314: "1",
    EPIC_ACAT_ADVISOR_LIST_TKT324: "1",
    SHOW_ACAT_ADVISOR_LIST_TKT338: "1",
  };
  Object.assign(process.env, values);
  return values;
});

const memory = vi.hoisted(() => ({ rows: new Map<string, { doc: unknown; position: number; updatedAt: Date }>() }));
const users = vi.hoisted(() => new Map<string, string>());
const profiles = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/demo/stand-ins/store", () => {
  const key = (service: string, kind: string, id: string) => `${service}|${kind}|${id}`;
  const list = (service: string, kind: string) => [...memory.rows.entries()]
    .filter(([k]) => k.startsWith(`${service}|${kind}|`))
    .sort((a, b) => a[1].position - b[1].position || a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ id: k.split("|")[2], doc: structuredClone(v.doc), updatedAt: v.updatedAt }));
  return {
    listRecords: vi.fn(async (service: string, kind: string) => list(service, kind)),
    readRecord: vi.fn(async (service: string, kind: string, id: string) => {
      const row = memory.rows.get(key(service, kind, id));
      return row ? { id, doc: structuredClone(row.doc), updatedAt: row.updatedAt } : null;
    }),
    saveRecord: vi.fn(async (service: string, kind: string, id: string, doc: unknown) => {
      memory.rows.set(key(service, kind, id), { doc: structuredClone(doc), position: memory.rows.size, updatedAt: new Date() });
    }),
    changeRecord: vi.fn(async (service: string, kind: string, id: string, change: (doc: unknown) => unknown) => {
      const row = memory.rows.get(key(service, kind, id));
      if (!row) return null;
      const next = change(structuredClone(row.doc));
      if (!next) return structuredClone(row.doc);
      memory.rows.set(key(service, kind, id), { ...row, doc: structuredClone(next), updatedAt: new Date() });
      return next;
    }),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(async ({ where }: { where: { email: string } }) => (users.has(where.email) ? { role: users.get(where.email) } : null)) } },
}));
vi.mock("@/lib/data/custodian-authority", () => ({
  readCustodianAuthorityProfiles: vi.fn(async () => ({ ok: true, value: profiles.value })),
}));

import { trackerRecords, trackerClients, pipelineHouseholds, custodianProfiles, USER } from "./fixtures/demo-tracker-records";
import { DEMO_LINKAGE_INSTALLATION_ID, TRACKER_ROUTES } from "@/lib/demo/stand-ins/tracker";
import { bookProjection, detailProjection, listProjection } from "@/lib/demo/stand-ins/tracker-model";
import {
  fetchAcatList, fetchAcatOpsBook, fetchAcatOpsList, getAcatStatus, getAcatStatusByRecordId, getAcatOpsStatusByRecordId,
  readAcatMachine, writeAcatBookRecord,
} from "@/lib/data/acat-status";
import { mapAcatBookRow } from "@/lib/data/acat-book";
import { mapDrawerTransfer, parseClientSearch, dtccSuggestionFrom } from "@/lib/data/acat-drawer-contract";
import { parseHistoryResponse } from "@/lib/data/acat-history-view";
import { readTransferFee, postTransferFee } from "@/lib/data/acat-fee";
import { loadRecon, runReconAction, searchReconAccounts } from "@/lib/data/acat-security-recon-server";
import { readAcatDashboard, postAcatDashboardReview } from "@/lib/data/acat-dashboard";
import { readAdvisorTransfers } from "@/lib/data/advisor-transfers";
import { readObservedCustodianTiming } from "@/lib/data/custodian-timing";
import { fetchTransferLinkageSnapshot } from "@/lib/data/acat-match-source";
import {
  loadTrackerTransferForm, confirmTrackerReceivingTitle, generateTrackerTransferForm, updateTrackerTransferScope, downloadTrackerTransferForm,
} from "@/lib/data/transfer-form-bridge";

const by = (id: string) => `/api/machine/acats/by-record/${encodeURIComponent(id)}`;
const stored = (id: string) => memory.rows.get(`tracker|acat|${id}`)!.doc as ReturnType<typeof trackerRecords>[number];

beforeEach(() => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  memory.rows.clear();
  trackerRecords().forEach((r, i) => memory.rows.set(`tracker|acat|${r.id}`, { doc: r, position: i, updatedAt: new Date() }));
  trackerClients().forEach((c, i) => memory.rows.set(`tracker|client|${c.cedarRidgeUserId}`, { doc: c, position: i, updatedAt: new Date() }));
  pipelineHouseholds().forEach((h, i) => memory.rows.set(`pipeline|household|${h.id}`, { doc: h, position: i, updatedAt: new Date() }));
  profiles.value = custodianProfiles();
  users.clear();
  users.set("rachel.moss@example.com", "ADVISOR");
  users.set("jordan.reyes@example.com", "OPERATIONS");
  users.set("helen.carver@example.com", "CLIENT_SERVICE");
});

describe("tracker stand-in: lists and books", () => {
  it("lists the firm-wide in-flight transfers, masked, without completed or removed ones", async () => {
    const rows = await fetchAcatList();
    expect(rows.map((r) => r.id)).toEqual(["rec-res-2", "rec-lee-8", "ACATREC-DEMO-0007", "rec-sam-9"]);
    const neil = rows.find((r) => r.id === "rec-lee-8")!;
    expect(neil).toMatchObject({ acatTransferId: "ACT-NEIL-8", apexAccountId: "*****ZHLK", statementAccountNumber: "*****9384", dtccNumber: "****" });
    expect(neil.assetMap).toEqual({ total: 2, mapped: 1, unmapped: 0, pending: 1, expected: 0 });
  });

  it("drops a rejected transfer once a later one exists for the same account", async () => {
    const retry = { ...trackerRecords().find((r) => r.id === "rec-sam-9")!, id: "rec-sam-10", status: "Submitted", rejectionReason: null,
      lastUpdated: "2026-10-29T12:00:00.000Z", createdAt: "2026-10-29T12:00:00.000Z" };
    memory.rows.set("tracker|acat|rec-sam-10", { doc: retry, position: 99, updatedAt: new Date() });
    const ids = (await fetchAcatList()).map((r) => r.id);
    expect(ids).toContain("rec-sam-10");
    expect(ids).not.toContain("rec-sam-9");
  });

  it("answers the operations book with whole account numbers, every book column, and the removed list", async () => {
    const book = await fetchAcatOpsBook();
    expect(book).toHaveLength(6);
    const done = book.find((r) => r.id === "rec-done-3")!;
    expect(done).toMatchObject({ apexAccountId: "9DZ60GC03", statementAccountNumber: "77012716", custodianName: "E*Trade", textLoadError: null, hasIssue: false });
    expect(done.records).toMatchObject({ reconStatus: "Complete", issueCount: 0, transferWorkflow: "ACAT (API)", feeAmount: "$75.00",
      cedarRidgeUserIds: USER.gavin, needsClientLink: false, expectedCompletionDate: "2026-08-12" });
    expect(Object.values(done.records!).every((v) => v !== null)).toBe(true);
    const removed = await fetchAcatOpsBook({ removed: true });
    expect(removed.map((r) => r.id)).toEqual(["rec-removed-5"]);
    expect(removed[0].removedAt).toBe("2026-09-10T16:00:00.000Z");
  });

  it("keeps the masked book read and the operations list in the same shapes", async () => {
    const res = await readAcatMachine("/api/machine/acats?book=full");
    expect(res.status).toBe(200);
    const rows = (res.data as { acats: unknown[] }).acats.map(mapAcatBookRow);
    expect(rows.every((r) => r && r.apexAccountId?.startsWith("*"))).toBe(true);
    expect((await fetchAcatOpsList()).find((r) => r.id === "rec-lee-8")!.apexAccountId).toBe("7QA41ZHLK");
    expect((await readAcatMachine("/api/machine/acats?book=full&removed=all")).status).toBe(400);
  });

  it("projects a record the way the tracker's redaction does", () => {
    const record = trackerRecords()[0];
    expect(listProjection(record)).toMatchObject({ lastActivityAt: record.lastUpdated, apexAccountId: "*****ZHLK" });
    expect(detailProjection(record)).toMatchObject({ identityVersion: 2, dtccNumber: "0226", cedarRidgeUserId: USER.neil, custodianId: "cust-fidelity" });
    expect(detailProjection(record, { ops: true }).statementAccountNumber).toBe("Z39129384");
    expect(bookProjection(record).tradeInstructionsBlank).toBe(false);
  });
});

describe("tracker stand-in: single records", () => {
  it("reads a record by transfer id and by record id; a removed or unknown record is not found", async () => {
    expect(await getAcatStatus("ACT-NEIL-8")).toMatchObject({ acatTransferId: "ACT-NEIL-8", status: "Accepted", dtccNumber: "****" });
    expect(await getAcatStatusByRecordId("rec-lee-8")).toMatchObject({ controlNumber: "C2026102001", dtccNumber: "0226" });
    expect(await getAcatOpsStatusByRecordId("rec-lee-8")).toMatchObject({ apexAccountId: "7QA41ZHLK" });
    expect(await getAcatStatusByRecordId("rec-removed-5")).toBeNull();
    expect(await getAcatStatus("ACT-NOBODY")).toBeNull();
  });

  it("serves the drawer read with the identity version and full numbers", async () => {
    const res = await readAcatMachine("/api/machine/acats/ops-drawer/rec-lee-8");
    expect(res.status).toBe(200);
    expect(mapDrawerTransfer(res.data)).toMatchObject({ id: "rec-lee-8", identityVersion: 2, statementAmount: 1871000, apexAccountId: "7QA41ZHLK" });
  });

  it("returns the field history newest first, without reads", async () => {
    const res = await readAcatMachine(`${by("rec-lee-8")}/history`);
    const parsed = parseHistoryResponse(res.status, res.data);
    expect(parsed).toMatchObject({ ok: true });
    expect((parsed as { entries: { action: string }[] }).entries.map((e) => e.action)).toEqual(["update"]);
  });
});

describe("tracker stand-in: record writes", () => {
  it("saves a book edit with history, and refuses what the tracker refuses", async () => {
    const saved = await writeAcatBookRecord("PATCH", by("rec-res-2"), { status: "Accepted", notes: "Contra confirmed." });
    expect(saved.status).toBe(200);
    expect(mapAcatBookRow(saved.data)).toMatchObject({ status: "Accepted" });
    expect(stored("rec-res-2").history.slice(0, 2).map((h) => h.field).sort()).toEqual(["notes", "status"]);
    expect((await writeAcatBookRecord("PATCH", by("rec-res-2"), { status: "Matched" })).status).toBe(400);
    expect((await writeAcatBookRecord("PATCH", by("rec-res-2"), { feeApexTicket: "X" })).data).toEqual({ error: "Field is not accepted on this path" });
    expect((await writeAcatBookRecord("PATCH", by("rec-res-2"), { status: "Nope" })).status).toBe(400);
    expect((await writeAcatBookRecord("PATCH", by("rec-removed-5"), { notes: "x" })).status).toBe(404);
  });

  it("makes a direction change to Out negative and opts it into residual monitoring", async () => {
    await writeAcatBookRecord("PATCH", by("rec-res-2"), { direction: "Out" });
    expect(stored("rec-res-2")).toMatchObject({ statementAmount: -512300, residualMonitoringRequired: true });
  });

  it("creates a transfer for a directory client and answers 201 with the detail", async () => {
    const res = await writeAcatBookRecord("POST", "/api/machine/acats", {
      cedarRidgeUserIds: [USER.asha], apexAccountId: "6PL90AP08", direction: "In", type: "Partial", transferringContra: "Schwab",
      statementAmount: 120000, acatDate: "2026-10-30",
    });
    expect(res.status).toBe(201);
    const row = mapAcatBookRow(res.data)!;
    expect(row).toMatchObject({ clientName: "Asha Patel", status: "AcatReceived", apexAccountId: "*****AP08" });
    expect(stored(row.id)).toMatchObject({ custodianId: "cust-schwab", custodianName: "Schwab", cedarRidgeUserIds: [USER.asha] });
    const unknown = await writeAcatBookRecord("POST", "/api/machine/acats", { cedarRidgeUserIds: ["user-00000000-0000-4000-8000-000000000000"], apexAccountId: "1" });
    expect(unknown.status).toBe(400);
    expect((await writeAcatBookRecord("POST", "/api/machine/acats", { clientName: "No One" })).data).toMatchObject({ code: "IDENTITY_REQUIRED" });
  });

  it("changes, completes and rejects through the drawer", async () => {
    const change = await writeAcatBookRecord("PATCH", `${by("rec-res-2")}/drawer`, { action: "change", field: "dtccNumber", value: "5198" });
    expect(change.status).toBe(200);
    expect(mapDrawerTransfer((change.data as { transfer: unknown }).transfer)).toMatchObject({ dtccNumber: "5198" });
    const blank = await writeAcatBookRecord("PATCH", `${by("rec-res-2")}/drawer`, { action: "change", field: "crmTicket", value: " " });
    expect(blank.status).toBe(400);
    expect(blank.data).toMatchObject({ error: "crmTicket cannot be blank", transfer: { id: "rec-res-2" } });
    const done = await writeAcatBookRecord("PATCH", `${by("rec-res-2")}/drawer`, { action: "complete", apexCompletionDate: "2026-10-30", controlNumber: "C2026103001" });
    expect((done.data as { transfer: { status: string } }).transfer.status).toBe("Completed");
    const rejected = await writeAcatBookRecord("PATCH", `${by("ACATREC-DEMO-0007")}/drawer`, { action: "reject", reason: "Contra rejected the request." });
    expect(stored("ACATREC-DEMO-0007")).toMatchObject({ status: "Rejected", rejectionReason: "Contra rejected the request." });
    expect(rejected.status).toBe(200);
  });

  it("replaces the client only at the version the drawer read", async () => {
    const stale = await writeAcatBookRecord("PATCH", `${by("rec-lee-8")}/drawer`, { action: "replaceClient",
      relink: { cedarRidgeUserIds: [USER.gavin], expectedIdentityVersion: 1, reason: "Wrong person", replaceDisplayName: true } });
    expect(stale.status).toBe(409);
    const ok = await writeAcatBookRecord("PATCH", `${by("rec-lee-8")}/drawer`, { action: "replaceClient",
      relink: { cedarRidgeUserIds: [USER.gavin], expectedIdentityVersion: 2, reason: "Wrong person", replaceDisplayName: true } });
    expect(ok.status).toBe(200);
    expect(stored("rec-lee-8")).toMatchObject({ clientName: "Gavin Carver", cedarRidgeUserIds: [USER.gavin], identityVersion: 3 });
  });

  it("removes a transfer and restores it once", async () => {
    const removed = await writeAcatBookRecord("DELETE", `${by("rec-res-2")}/drawer`, { reason: "Entered twice" });
    expect(removed.data).toMatchObject({ removed: true, transfer: { id: "rec-res-2" } });
    expect(await getAcatStatusByRecordId("rec-res-2")).toBeNull();
    expect((await writeAcatBookRecord("POST", `${by("rec-res-2")}/restore`, {})).status).toBe(200);
    expect((await writeAcatBookRecord("POST", `${by("rec-res-2")}/restore`, {})).status).toBe(409);
    expect((await writeAcatBookRecord("POST", `${by("nope")}/restore`, {})).status).toBe(404);
  });
});

describe("tracker stand-in: fees", () => {
  it("reads, saves and applies fee rules, and refuses a custodian with none", async () => {
    expect(await readTransferFee("rec-done-3")).toMatchObject({ ok: true, fee: { feeAmount: "$75.00", feeCharged: "Yes" }, log: null });
    expect(await postTransferFee("rec-done-3", { action: "save", fields: { feeRequestSubmitted: "10/01/2026" } }))
      .toMatchObject({ ok: true, fee: { feeRequestSubmitted: "2026-10-01" } });
    expect(await postTransferFee("rec-out-4", { action: "apply", feeRuleIds: ["fee-fid-1", "fee-fid-2"] }))
      .toMatchObject({ ok: true, fee: { feeAmount: "$75.00", feeMemo: "Full transfer: $50.00 + IRA closing: $25.00", feeCharged: "Yes" } });
    expect(await postTransferFee("rec-sam-9", { action: "apply", feeRuleIds: ["fee-fid-1"] })).toMatchObject({ ok: false, code: "no_rules" });
    expect(await postTransferFee("rec-out-4", { action: "apply", feeRuleIds: ["fee-unknown"] })).toMatchObject({ ok: false });
  });
});

describe("tracker stand-in: security reconciliation", () => {
  it("reads the stored grid, saves rows, and refreshes from the linked statement account", async () => {
    expect(await loadRecon("rec-lee-8")).toMatchObject({ ok: true, snapshot: { acatId: "rec-lee-8", counts: { total: 2, matched: 1 } } });
    const saved = await runReconAction("rec-lee-8", { action: "save", apexUploaded: true, overriddenIds: [],
      rows: [{ id: "asset-neil-2", symbol: "AAPL", description: "Apple Inc", cusip: null, actualQty: 40, amount: 912000, assetClass: "Equity",
        status: "Matched", issue: null, notes: null }] });
    expect(saved).toMatchObject({ ok: true, snapshot: { apexSource: "Uploaded", counts: { matched: 2, reconRate: 100 } } });
    expect(stored("rec-lee-8").reconCompletedAt).not.toBeNull();
    const refreshed = await runReconAction("rec-lee-8", { action: "refresh" });
    expect(refreshed).toMatchObject({ ok: true, snapshot: { sourceAccount: { holder: "Neil Walker", accountNumberLast4: "9384" } } });
    expect(stored("rec-lee-8").assets.find((a) => a.symbol === "VTI")).toMatchObject({ id: "asset-neil-1", mappingTransferring: true });
  });

  it("refuses an upload and a refresh with no account, with the stored grid", async () => {
    const upload = await runReconAction("rec-lee-8", { action: "upload", kind: "apex", filename: "apex.csv", text: "a,b" });
    expect(upload).toMatchObject({ ok: false, refused: true, status: 422, message: "Uploading a file isn't part of the demo." });
    const missing = await runReconAction("rec-sam-9", { action: "refresh" });
    expect(missing).toMatchObject({ ok: false, refused: true, status: 404 });
  });

  it("searches the statement pipeline's accounts", async () => {
    expect(await searchReconAccounts("rec-lee-8", "walker")).toMatchObject({ ok: true, accounts: [{ holder: "Neil Walker", positionCount: 2 }] });
  });
});

describe("tracker stand-in: directory, DTC, custodians", () => {
  it("searches the client directory with masked hints and a write-eligible directory", async () => {
    const res = await readAcatMachine("/api/machine/clients/search?query=neil&limit=20");
    const parsed = parseClientSearch(res.data);
    expect(parsed.clients.map((i) => i.displayName)).toEqual(["Neil Walker"]);
    expect(parsed.clients[0].accountHints[0].maskedAccountNumber).toBe("••••ZHLK");
    expect(parsed.directory?.writeEligible).toBe(true);
    expect(parseClientSearch((await readAcatMachine("/api/machine/clients/search?query=neila")).data).clients).toEqual([]);
  });

  it("suggests the custodian's DTC number", async () => {
    const res = await readAcatMachine("/api/machine/dtcc-suggestion?contra=Fidelity");
    expect(dtccSuggestionFrom(res.data)).toEqual({ status: "suggested", dtccNumber: "0226" });
  });

  it("reports observed timing per custodian in the shape AoA's strict parser takes", async () => {
    const timing = await readObservedCustodianTiming();
    expect(timing.get("cust-etrade")).toEqual({ observedAvgProcessingBusinessDays: 7, observedCompletedTransfers: 1 });
    expect(timing.get("cust-merrill")).toEqual({ observedAvgProcessingBusinessDays: null, observedCompletedTransfers: 0 });
  });
});

describe("tracker stand-in: dashboard, advisor list, linkage", () => {
  it("composes the operations dashboard AoA's strict parser accepts, and records a review", async () => {
    const result = await readAcatDashboard();
    expect(result).toMatchObject({ ok: true });
    const data = (result as { dashboard: { summary: { Completed: number }; residuals: { queue: unknown[] }; quality: { exceptions: { ruleKey: string; fingerprint: string; record: { id: string } }[] } } }).dashboard;
    expect(data.summary.Completed).toBe(2);
    expect(data.residuals.queue).toHaveLength(1);
    const exception = data.quality.exceptions.find((e) => e.ruleKey === "residual_sweep_missing")!;
    const review = await postAcatDashboardReview({ acatRecordId: exception.record.id, ruleKey: exception.ruleKey, fingerprint: exception.fingerprint,
      status: "IN_REVIEW", resolution: null, note: "Asked the contra." });
    expect(review).toMatchObject({ ok: true });
    expect(stored("rec-out-4").reviews).toHaveLength(1);
  });

  it("lists transfers for an advisor and refuses other roles", async () => {
    expect(await readAdvisorTransfers("Rachel.Moss@example.com")).toMatchObject({ ok: true });
    const rows = ((await readAdvisorTransfers("rachel.moss@example.com")) as { rows: { id: string; custodian: unknown }[] }).rows;
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.id === "rec-lee-8")!.custodian).toEqual({ id: "cust-fidelity", name: "Fidelity", avgProcessingDays: 6 });
    expect(await readAdvisorTransfers("helen.carver@example.com")).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("publishes a transfer-linkage snapshot AoA's validator accepts", async () => {
    const snapshot = await fetchTransferLinkageSnapshot();
    expect(snapshot.source).toEqual({ system: "transfer-tracker", installationId: DEMO_LINKAGE_INSTALLATION_ID, environment: "production" });
    expect(snapshot.recordCount).toBe(7);
    const neil = snapshot.records.find((r) => r.recordId === "rec-lee-8")!;
    expect(neil.receivingAccount).toMatchObject({ id: "inv-neil-1", verification: "VERIFIED", holderSetComplete: true });
    expect(snapshot.records.find((r) => r.recordId === "rec-res-2")!.receivingAccount.verification).toBe("MISSING_IDENTITY");
  });
});

describe("tracker stand-in: transfer forms", () => {
  const jordan = { email: "jordan.reyes@example.com", role: "OPERATIONS" };

  it("prepares, confirms the title, generates and downloads the transfer request", async () => {
    const first = await loadTrackerTransferForm(jordan, "ACATREC-DEMO-0007");
    expect(first).toMatchObject({ direction: "INCOMING", scope: "FULL", custodian: { id: "cust-fidelity" }, confirmation: null });
    expect(first.blockers.map((b) => b.code)).toEqual(["receiving_confirmation"]);
    expect(first.requirements).toContainEqual({ label: "Client signature", value: "Client signature required" });
    const confirmed = await confirmTrackerReceivingTitle(jordan, "ACATREC-DEMO-0007", { expectedRevision: first.sourceRevision,
      operationId: "0d6c7b9a-1e2f-4a3b-8c4d-5e6f7a8b9c0d", title: "Asha Patel Traditional IRA", registration: "Traditional IRA", confirmed: true });
    expect(confirmed.confirmation).toMatchObject({ valid: true, source: "AOA", confirmedBy: "jordan.reyes@example.com" });
    expect(confirmed.blockers).toEqual([]);
    const { documentId } = await generateTrackerTransferForm(jordan, "ACATREC-DEMO-0007", {
      expectedRevision: confirmed.sourceRevision, confirmationId: confirmed.confirmation!.id!, operationId: "1e7d8c0b-2f3a-4b4c-9d5e-6f7a8b9c0d1e",
      workflowId: confirmed.workflows[0].id, assetInstruction: "IN_KIND", deliveringTitle: "Asha Patel IRA", deliveringTitleConfirmed: true,
      accountsReviewed: true, instructionsReviewed: true, letterOfAuthorizationRequired: false,
    });
    const download = await downloadTrackerTransferForm(jordan, "ACATREC-DEMO-0007", documentId);
    expect(download.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await loadTrackerTransferForm(jordan, "ACATREC-DEMO-0007")).documents.map((d) => d.id)).toEqual([documentId]);
  });

  it("refuses a stale revision, a non-operations actor and a missing record", async () => {
    const prep = await loadTrackerTransferForm(jordan, "rec-res-2");
    await updateTrackerTransferScope(jordan, "rec-res-2", { expectedRevision: prep.sourceRevision, operationId: "2f8e9d1c-3a4b-4c5d-8e6f-7a8b9c0d1e2f", scope: "FULL", confirmed: true });
    expect(stored("rec-res-2").type).toBe("Full");
    await expect(updateTrackerTransferScope(jordan, "rec-res-2", { expectedRevision: prep.sourceRevision,
      operationId: "3a9f0e2d-4b5c-4d6e-9f7a-8b9c0d1e2f3a", scope: "PARTIAL", confirmed: true })).rejects.toMatchObject({ reason: "stale" });
    await expect(loadTrackerTransferForm({ email: "nobody@example.com", role: "OPERATIONS" }, "rec-res-2")).rejects.toMatchObject({ reason: "forbidden" });
    await expect(loadTrackerTransferForm(jordan, "rec-removed-5")).rejects.toMatchObject({ reason: "not_found" });
  });
});

describe("tracker stand-in: dark routes", () => {
  it("answers the custodian projection push as switched off", async () => {
    const res = await writeAcatBookRecord("POST", "/api/machine/custodians/projection", {});
    expect(res.status).toBe(404);
    expect(TRACKER_ROUTES.length).toBeGreaterThan(25);
  });
});
