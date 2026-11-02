// The demo's visitor workflow (plan T2 and T4) through the app's own server actions, on a freshly seeded database,
// as the personas a visitor signs in as:
//   T2  Rachel (advisor) finds the Okafor household's story end to end, and each record that also lives in another
//       demo links there by the id that demo uses. Jordan (operations) reviews the asset map waiting for review,
//       confirms Okafor's partial ACAT arrived with the demo's sample receipt (which moves it to Funded), and
//       approves Okafor's trade request, then confirms it as the source of the joint account's investment profile.
//       Priya (admin) finds Jordan's work in the Audit Log; the approval is in the request's own history, where the
//       app records it.
//   T4  The Slack closeout checklist, the trade-request message and the operations fee alert land in the Outbox, and
//       each persona reads there only the messages about the households and clients its row security shows it.
// Opt-in: DEMO_SEED_TEST_OWNER_URL is the owner login of a freshly migrated loopback database. It seeds and writes
// that database, so point it at a throwaway copy.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
class Redirected extends Error {
  constructor(readonly url: string) { super(`redirect ${url}`); }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Redirected(url); },
  notFound: () => { throw new Error("notFound"); },
}));

const OWNER_URL = process.env.DEMO_SEED_TEST_OWNER_URL;
const RUN = OWNER_URL ? describe : describe.skip;

const DEMO_CONFIG = JSON.parse(readFileSync(new URL("../demo-config.json", import.meta.url), "utf8")) as Record<string, string>;
const LOGIN_KEYS = ["DATABASE_URL", "INGEST_DATABASE_URL", "CRM_RECONCILER_DATABASE_URL"];
const savedEnv: Record<string, string | undefined> = {};

const PERSONAS = {
  rachel: { role: "ADVISOR", email: "rachel.moss@example.com" },
  jordan: { role: "OPERATIONS", email: "jordan.reyes@example.com" },
  priya: { role: "ADMIN", email: "priya.nair@example.com" },
} as const;
// Another advisor's book, for the Outbox's row security.
const SAM = { role: "ADVISOR", email: "sam.ortiz@example.com" } as const;
type Persona = keyof typeof PERSONAS;

// The Okafor story's records, under the ids the other demos give them.
const OKAFOR = {
  trackerRecord: "tr-t298",
  statementRun: "f5d084fb-f428-4bcb-a1f5-b68a6fd6863c", // sample-okafor#2, as the Statement Analyzer's reset derives it
  tradeRequest: "REQ-00001045",
};

function loopback(raw: string): string {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== "aoa") throw new Error("loopback_demo_workflow_database_required");
  return raw;
}

RUN("demo visitor workflow (T2, T4)", () => {
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let actions: {
    confirmLink: typeof import("@/app/(authenticated)/asset-mapping-review/actions").confirmLink;
    transfer: typeof import("@/app/(authenticated)/asset-transfer/actions");
    changeTradeRequestStatus: typeof import("@/app/(authenticated)/trade-requests/status-actions").changeTradeRequestStatus;
    submitOperationsFeeRequest: typeof import("@/app/(authenticated)/operations/fee-requests/actions").submitOperationsFeeRequest;
    listAuditLog: typeof import("@/lib/data/audit-log").listAuditLog;
    withUserScope: typeof import("@/lib/rls").withUserScope;
    confirmTradeProfileSource: typeof import("@/app/(authenticated)/client-portrait/[id]/actions").confirmTradeProfileSource;
  };
  let sf: Map<string, string>;
  let tradeProfile: (personId: string) => Promise<import("@/lib/data/trade-request-profile").TradeRequestProfile>;
  let links: typeof import("@/lib/demo/links").otherDemoLinks;
  let assetMapWorkspaceScope: typeof import("@/lib/data/asset-map-workspace-scope").ASSET_MAP_WORKSPACE_SCOPE;
  let ids: { okaforTransfer: string; nakamuraTransfer: string; okaforRun: string };
  const userIds = new Map<string, string>();

  async function signIn(persona: Persona) {
    const { role, email } = PERSONAS[persona];
    auth.mockResolvedValue({ user: { id: userIds.get(email), email, role, name: persona } });
  }
  const outbox = () =>
    owner.$queryRaw<Array<{ channel: string; destination: string; title: string }>>`
      SELECT channel, destination, title FROM demo.outbox_message ORDER BY id`;
  async function waitForOutbox(count: number) {
    for (let i = 0; i < 50; i++) {
      const rows = await outbox();
      if (rows.length >= count) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return outbox();
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(DEMO_CONFIG)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const { demoLoginUrls, ensureDemoLogins } = await import("@/lib/demo/logins");
    const logins = demoLoginUrls(loopback(OWNER_URL!));
    for (const key of LOGIN_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = logins[key as keyof typeof logins];
    }
    owner = new PrismaClient({ datasourceUrl: OWNER_URL });
    ingest = new PrismaClient({ datasourceUrl: logins.INGEST_DATABASE_URL });
    const [{ held }] = await owner.$queryRaw<Array<{ held: bigint }>>`SELECT count(*) AS held FROM app.transfer`;
    if (held > 0n) throw new Error("DEMO_SEED_TEST_OWNER_URL must be a freshly migrated database");
    await ensureDemoLogins(owner, OWNER_URL!);

    const { seedDemo } = await import("@/lib/demo/seed");
    const { cedarRidgeUserId, loadUniverse, personIds, storyTransferId } = await import("@/lib/demo/seed/universe");
    const { runId } = await import("@/lib/demo/seed/asset-maps-snapshot");
    const universe = loadUniverse();
    await seedDemo(universe, owner, ingest);
    sf = personIds(universe);
    ids = { okaforTransfer: storyTransferId("T-298"), nakamuraTransfer: storyTransferId("T-311"), okaforRun: runId("sample-okafor#2") };
    for (const { email } of Object.values(PERSONAS)) {
      const [user] = await owner.$queryRaw<Array<{ id: string }>>`SELECT id FROM app."User" WHERE email = ${email}`;
      userIds.set(email, user.id);
    }

    actions = {
      confirmLink: (await import("@/app/(authenticated)/asset-mapping-review/actions")).confirmLink,
      transfer: await import("@/app/(authenticated)/asset-transfer/actions"),
      changeTradeRequestStatus: (await import("@/app/(authenticated)/trade-requests/status-actions")).changeTradeRequestStatus,
      submitOperationsFeeRequest: (await import("@/app/(authenticated)/operations/fee-requests/actions")).submitOperationsFeeRequest,
      listAuditLog: (await import("@/lib/data/audit-log")).listAuditLog,
      withUserScope: (await import("@/lib/rls")).withUserScope,
      confirmTradeProfileSource: (await import("@/app/(authenticated)/client-portrait/[id]/actions")).confirmTradeProfileSource,
    };
    // The Client Portrait's investment profile, as its server component derives it for Priya.
    const { getTradeRequestsForUser } = await import("@/lib/data/trade-requests");
    const { apexAccountsForClient } = await import("@/lib/data/account-aum");
    const { tradeProfileSelectionsForClient } = await import("@/lib/data/trade-profile-selection");
    const { deriveAccountScopedTradeRequestProfileFromSummaries } = await import("@/lib/data/trade-request-profile");
    tradeProfile = async (personId) => {
      const clientSfId = sf.get(personId)!;
      const [requests, accounts, selections] = await Promise.all([
        getTradeRequestsForUser(cedarRidgeUserId(personId)),
        apexAccountsForClient(PERSONAS.priya, clientSfId),
        tradeProfileSelectionsForClient(PERSONAS.priya, clientSfId),
      ]);
      return deriveAccountScopedTradeRequestProfileFromSummaries(
        cedarRidgeUserId(personId),
        requests,
        accounts.map((a) => ({
          accountId: a.custodianAccountId, accountNumber: a.apexAccountNumber ?? a.custodianAccountId, accountType: a.accountType, status: a.accountStatus,
        })),
        Object.fromEntries(selections.map((s) => [s.accountId, { requestId: s.requestId, reviewedRequestIds: s.reviewedRequestIds }])),
      );
    };
    links = (await import("@/lib/demo/links")).otherDemoLinks;
    assetMapWorkspaceScope = (await import("@/lib/data/asset-map-workspace-scope")).ASSET_MAP_WORKSPACE_SCOPE;
  }, 120_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await ingest?.$disconnect();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("T2: Rachel finds the Okafor story end to end, through her own row security", async () => {
    const story = await actions.withUserScope(PERSONAS.rachel, async (tx) => {
      const [household] = await tx.$queryRaw<Array<{ sf_id: string; name: string }>>`
        SELECT sf_id, name FROM mirror.household WHERE name = 'Okafor Household'`;
      const transfer = await tx.transfer.findUnique({
        where: { id: ids.okaforTransfer },
        select: { stage: true, funding_type: true, acat_record_id: true, asset_map_folder_id: true, deal_id: true },
      });
      return { household, transfer };
    });
    // Advisors read asset maps in the Asset Mapping workspace, whose reads carry its scope.
    const [run] = await actions.withUserScope(PERSONAS.rachel, (tx) => tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM mirror.acat_asset_map_household WHERE source_folder_id = 'sample-okafor' AND superseded_by IS NULL`,
    assetMapWorkspaceScope);
    expect(story.household?.name).toBe("Okafor Household");
    expect(story.transfer).toMatchObject({ stage: "IN_TRANSFER", funding_type: "ACAT_PARTIAL", acat_record_id: OKAFOR.trackerRecord, asset_map_folder_id: "sample-okafor" });
    expect(story.transfer?.deal_id).toBeTruthy();
    expect(run?.id).toBe(OKAFOR.statementRun);
    const [request] = await owner.$queryRaw<Array<{ status: string; advisor_email: string }>>`
      SELECT r.status, u.email AS advisor_email FROM trade_request.trade_requests r
        JOIN trade_request.users u ON u.id = r.advisor_id WHERE r.id = ${OKAFOR.tradeRequest}`;
    expect(request).toEqual({ status: "Pending Review", advisor_email: PERSONAS.rachel.email });
  });

  it("T2: each of those records links to the same record in the other demos", () => {
    expect(ids.okaforRun).toBe(OKAFOR.statementRun);
    expect(links.trackerRecord(OKAFOR.trackerRecord)).toBe("https://transfers.jeremyhamann.dev/records?open=tr-t298");
    expect(links.statementRun(ids.okaforRun)).toBe(`https://statements.jeremyhamann.dev/run/${OKAFOR.statementRun}`);
    expect(links.tradeRequest(OKAFOR.tradeRequest)).toBe("https://trade.jeremyhamann.dev/queue/REQ-00001045");
  });

  it("T2: Rachel can't take Jordan's operations steps", async () => {
    await signIn("rachel");
    expect((await actions.transfer.sampleReceiptCsv(ids.okaforTransfer)).ok).toBe(false);
    const [{ updated_at }] = await owner.$queryRaw<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM trade_request.trade_requests WHERE id = ${OKAFOR.tradeRequest}`;
    const refused = await actions.changeTradeRequestStatus(OKAFOR.tradeRequest, { status: "Approved", note: "", expectedUpdatedAt: updated_at.toISOString() });
    expect(refused.ok).toBe(false);
  });

  it("T2: Jordan reviews the asset map waiting for review", async () => {
    await signIn("jordan");
    const [delgado] = await owner.$queryRaw<Array<{ sf_id: string }>>`
      SELECT sf_id FROM mirror.client WHERE first_name = 'Marisol' AND last_name = 'Delgado'`;
    expect(await actions.confirmLink("sample-delgado", delgado.sf_id)).toEqual({ ok: true });
    const [link] = await owner.$queryRaw<Array<{ match_status: string; client_sf_id: string; confirmed_by: string }>>`
      SELECT match_status, client_sf_id, confirmed_by FROM mirror.acat_asset_map_link WHERE source_folder_id = 'sample-delgado'`;
    expect(link).toEqual({ match_status: "CONFIRMED", client_sf_id: delgado.sf_id, confirmed_by: PERSONAS.jordan.email });
  });

  it("T2: Jordan confirms the arrival with the sample receipt, which moves the transfer to Funded", async () => {
    await signIn("jordan");
    const sample = await actions.transfer.sampleReceiptCsv(ids.okaforTransfer);
    if (!sample.ok) throw new Error(JSON.stringify(sample.errors));
    expect(sample.csv.split("\n")[0]).toBe("Symbol,Quantity");
    const compared = await actions.transfer.applyReceiptComparison(ids.okaforTransfer, sample.csv);
    if (!compared.ok) throw new Error(JSON.stringify(compared.errors));
    // Every holding with a quantity matches; a line with none (cash) is verified with a note, as a reviewer would.
    expect(compared.lines.filter((l) => l.expectedQuantity !== null).every((l) => l.classification === "matched")).toBe(true);
    const saved = await actions.transfer.saveTransferReceipt(ids.okaforTransfer, {
      partial: false,
      lines: compared.lines.map((line) => ({
        classification: line.classification,
        quantity: line.quantity,
        lineStatus: "verified",
        variancePercentage: line.variancePercentage,
        reviewNote: line.reviewNote,
        explanation: line.classification === "matched" ? line.explanation : "Cash posted to the receiving account's sweep.",
      })),
      nextAction: "",
      followUpOwner: "",
      nextCheckOn: "",
    });
    expect(saved).toMatchObject({ ok: true });
    const [transfer] = await owner.$queryRaw<Array<{ stage: string }>>`SELECT stage FROM app.transfer WHERE id = ${ids.okaforTransfer}`;
    expect(transfer.stage).toBe("FUNDED");
  });

  it("T2 + T4: Jordan approves the trade request; the advisor gets the Slack message in the Outbox", async () => {
    await signIn("jordan");
    const before = (await outbox()).length;
    const [{ updated_at }] = await owner.$queryRaw<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM trade_request.trade_requests WHERE id = ${OKAFOR.tradeRequest}`;
    const approved = await actions.changeTradeRequestStatus(OKAFOR.tradeRequest, {
      status: "Approved", note: "Approved for the closing.", expectedUpdatedAt: updated_at.toISOString(),
    });
    expect(approved.ok).toBe(true);
    const [request] = await owner.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM trade_request.trade_requests WHERE id = ${OKAFOR.tradeRequest}`;
    expect(request.status).toBe("Approved");
    const history = await owner.$queryRaw<Array<{ action: string }>>`
      SELECT action FROM trade_request.audit_logs WHERE request_id = ${OKAFOR.tradeRequest} ORDER BY created_at`;
    expect(history.map((h) => h.action)).toContain("Status changed to Approved");
    const rows = await waitForOutbox(before + 1);
    expect(rows.slice(before).some((r) => r.channel === "Slack" && r.destination === "Direct message")).toBe(true);
  });

  it("T2: the approved joint-account rebalance waits on Kofi's joint account until Jordan confirms it", async () => {
    // It names both Okafors, so it sets nobody's profile on its own; Ada's own SEP IRA keeps its own source.
    const pending = await tradeProfile("okafor-kofi");
    expect(pending.accountReview?.accounts.map((a) => [a.accountType, a.state])).toEqual([["Joint", "scope_review"]]);
    expect(pending.risk).toBeNull();
    const ada = await tradeProfile("okafor-ada");
    expect(ada.accountReview?.accounts.map((a) => [a.accountType, a.state, a.risk?.sourceRequestId])).toEqual([["SEP IRA", "ready", "REQ-00000901"]]);

    await signIn("jordan");
    const joint = pending.accountReview!.accounts[0];
    const confirmed = await actions.confirmTradeProfileSource(sf.get("okafor-kofi")!, joint.accountId, OKAFOR.tradeRequest, "Joint account rebalance");
    expect(confirmed).toEqual({ ok: true });
    const kofi = await tradeProfile("okafor-kofi");
    expect(kofi).toMatchObject({ state: "ready", risk: { sourceRequestId: OKAFOR.tradeRequest } });
    expect(kofi.sources).toEqual([expect.objectContaining({ requestId: OKAFOR.tradeRequest, scope: "household" })]);
  });

  it("T2: Priya finds Jordan's asset-map review, receipt, stage change and profile confirmation in the Audit Log", async () => {
    const log = await actions.listAuditLog(PERSONAS.priya, { pageSize: 200 });
    if (!log.ok) throw new Error("audit log refused");
    const jordans = log.rows.filter((r) => r.actorEmail === PERSONAS.jordan.email);
    expect(jordans.some((r) => r.action === "asset_map_link.confirm" && r.entityId === "sample-delgado")).toBe(true);
    expect(jordans.some((r) => r.action === "transfer.receipt_record" && r.entityId === ids.okaforTransfer)).toBe(true);
    const stage = jordans.find((r) => r.action === "transfer.stage_change" && r.entityId === ids.okaforTransfer);
    expect(stage && JSON.parse(String(stage.detail))).toMatchObject({ from: "IN_TRANSFER", to: "FUNDED" });
    const source = jordans.find((r) => r.action === "trade_profile.source_confirm");
    expect(source && JSON.parse(String(source.detail))).toMatchObject({ requestId: OKAFOR.tradeRequest, priorRequestId: null });
  });

  it("T4: moving a transfer to In Transfer puts the Slack closeout checklist in the Outbox", async () => {
    await signIn("jordan");
    const before = (await outbox()).length;
    const moved = await actions.transfer.setStage(ids.nakamuraTransfer, "IN_TRANSFER");
    expect(moved).toMatchObject({ ok: true });
    const rows = await outbox();
    expect(rows.slice(before)).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "Slack", destination: "#transfers (via n8n)" }),
    ]));
  });

  it("T4: an operations fee request puts the fee alert in the Outbox", async () => {
    await signIn("jordan");
    const before = (await outbox()).length;
    const [account] = await owner.$queryRaw<Array<{ client_sf_id: string; custodian_account_id: string }>>`
      SELECT client_sf_id, custodian_account_id FROM mirror.client_account_aum
       WHERE source_present AND client_sf_id IS NOT NULL ORDER BY custodian_account_id LIMIT 1`;
    const form = new FormData();
    form.set("requestKind", "FEE_CREDIT");
    form.set("clientSfId", account.client_sf_id);
    form.append("accountIds", account.custodian_account_id);
    form.append("feeTypes", "ACAT in");
    form.set("feeAmount", "75.00");
    form.set("reason", "Delivering firm's ACAT fee, reimbursed per the transfer agreement.");
    form.set("relevantTicketRefs", "");
    form.set("submissionKey", randomUUID());
    const outcome = await actions.submitOperationsFeeRequest(form).then(() => null, (e: unknown) => e);
    expect(outcome).toBeInstanceOf(Redirected);
    expect((outcome as Redirected).url).toMatch(/request=/);
    const rows = await outbox();
    expect(rows.slice(before)).toEqual(expect.arrayContaining([expect.objectContaining({ destination: "#operations" })]));
  });

  it("T4: each persona reads only the Outbox messages its row security shows", async () => {
    const { listOutbox } = await import("@/lib/demo/outbox");
    const read = (identity: { role: string; email: string }) => actions.withUserScope(identity, (tx) => listOutbox(tx, 200));
    const everything = await read(PERSONAS.jordan);
    expect(everything.map((m) => m.destination)).toEqual(expect.arrayContaining(["Direct message", "#transfers (via n8n)", "#operations"]));
    expect((await read(PERSONAS.priya)).map((m) => m.id)).toEqual(everything.map((m) => m.id));

    // Whose book each message is about, from what it recorded (owner read, past row security).
    const about = await owner.$queryRaw<Array<{ id: bigint; advisors: string[] }>>`
      SELECT m.id, array_remove(array_agg(DISTINCT coalesce(h.lead_advisor_email, c.lead_advisor_email, u.lead_advisor_email)), NULL) AS advisors
        FROM demo.outbox_message m
        LEFT JOIN mirror.household h ON h.sf_id = m.household_sf_id
        LEFT JOIN mirror.client c ON c.sf_id = m.client_sf_id
        LEFT JOIN mirror.client u ON u.cedar_ridge_user_id = m.cedar_ridge_user_id
       GROUP BY m.id`;
    const bookOf = (email: string) => about.filter((a) => a.advisors.includes(email)).map((a) => a.id.toString()).sort();
    const rachels = await read(PERSONAS.rachel);
    expect(rachels.some((m) => m.destination === "Direct message")).toBe(true);
    expect(rachels.map((m) => m.id).sort()).toEqual(bookOf(PERSONAS.rachel.email));
    const sams = await read(SAM);
    expect(sams.some((m) => m.destination === "Direct message")).toBe(false);
    expect(sams.map((m) => m.id).sort()).toEqual(bookOf(SAM.email));
    expect(rachels.length).toBeLessThan(everything.length);
  });
});
