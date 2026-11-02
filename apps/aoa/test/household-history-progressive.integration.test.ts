import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
import { getHouseholdHistoryPage } from "@/lib/data/household-history";
import { tasksForHouseholdSources } from "@/lib/data/tasks";
import { emailsForHouseholdSources } from "@/lib/data/emails";
import { activityForHouseholdSources } from "@/lib/data/activity";
import { GET as tasksApi } from "@/app/api/navigation/household-tasks/route";
import { GET as emailApi } from "@/app/api/navigation/household-email/route";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "history-advisor@example.invalid" };
const HH1 = "001XMV975191317", HH2 = "001VEP218937432", OTHER = "001VFU206882425";
const ID1 = "hld_historysyn1", ID2 = "hld_historysyn2";
const CANDIDATE = "dup_c" + "51504a".padStart(24, "0");
const request = (query = "") => new Request(`https://example.test/api/navigation/household-tasks?household=${HH1}${query ? `&${query}` : ""}`);

gated("bounded household histories against synthetic PostgreSQL and canonical/RLS scope", () => {
  let owner: PrismaClient;
  async function assign(task: string, sourceId: string, type: "USER" | "QUEUE", name: string | null) {
    await owner.$executeRaw`UPDATE mirror.task SET assignment_state = 'ASSIGNED',
      assignee_sf_id = ${sourceId}, assignee_type = ${type}, assignee_name = ${name},
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz WHERE sf_id = ${task}`;
  }
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.task WHERE sf_id LIKE 'HST-SYN-%'`;
    await owner.$executeRaw`DELETE FROM mirror.email WHERE sf_id LIKE 'HST-SYN-%'`;
    await owner.$executeRaw`DELETE FROM mirror.activity WHERE sf_id LIKE 'HST-SYN-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id = ${CANDIDATE}`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id = ${CANDIDATE}`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id IN ('history-syn-map1', 'history-syn-map2')`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id IN (${ID1}, ${ID2})`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${HH1}, ${HH2}, ${OTHER})`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk IN (${ID1}, ${ID2}, ${CANDIDATE}, 'history-syn-map1', 'history-syn-map2')`;
  }
  beforeAll(async () => {
    const cleanupUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!cleanupUrl || !process.env.DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    const expected = new URL(cleanupUrl);
    for (const raw of [cleanupUrl, process.env.DATABASE_URL]) {
      const parsed = new URL(raw);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.pathname !== expected.pathname ||
        !(parsed.pathname === "/aoa_rollout_synthetic" || parsed.pathname === "/aoa_pagination_synthetic" ||
          (process.env.CI === "true" && parsed.pathname === "/aoa"))) throw new Error("isolated_synthetic_database_required");
    }
    if (expected.username !== "aoa" || new URL(process.env.DATABASE_URL).username !== "app_rw") throw new Error("synthetic_database_roles_required");
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await cleanup();
  });
  beforeEach(async () => {
    await cleanup();
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    auth.mockResolvedValue({ user: ADVISOR, navigationScope: "a".repeat(64) });
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${HH1}, 'Invented history household', ${ADVISOR.email}),
        (${HH2}, 'Invented history duplicate', ${ADVISOR.email}),
        (${OTHER}, 'Invented other book', 'other-history@example.invalid')`;
    await owner.$executeRaw`INSERT INTO mirror.task (sf_id, household_sf_id, subject, status, description, source_modified_at)
      SELECT 'HST-SYN-T-' || lpad(i::text, 4, '0'), ${HH1}, 'Invented task', CASE WHEN i <= 105 THEN 'Not Started' ELSE ' Completed ' END,
        'Synthetic note only', '2026-09-01'::timestamptz FROM generate_series(1, 205) i`;
    await owner.$executeRaw`INSERT INTO mirror.email (sf_id, household_sf_id, subject, body, sent_at)
      SELECT 'HST-SYN-E-' || lpad(i::text, 4, '0'), ${HH1}, 'Invented email', 'Synthetic email only', '2026-09-01'::timestamptz
      FROM generate_series(1, 205) i`;
    await owner.$executeRaw`INSERT INTO mirror.activity (sf_id, household_sf_id, subject, note, activity_at, source_modified_at)
      SELECT 'HST-SYN-A-' || lpad(i::text, 4, '0'), ${HH1}, 'Invented call', 'Synthetic call only',
        CASE WHEN i = 1 THEN NULL ELSE '2026-09-01'::timestamptz END, '2026-09-02'::timestamptz FROM generate_series(1, 205) i`;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it.each(["tasks", "email", "activity"] as const)("%s reads100/100/5 with stable unique order and compact snapshots", async kind => {
    const pages = await Promise.all([1, 2, 3].map(page => getHouseholdHistoryPage(ADVISOR, HH1, kind, { page, includeCompleted: true })));
    expect(pages.map(page => page?.rows.length)).toEqual([100, 100, 5]);
    expect(new Set(pages.flatMap(page => page!.rows.map(row => row.sf_id))).size).toBe(205);
    expect(new Set(pages.map(page => page?.snapshot)).size).toBe(1);
    expect(pages[0]?.total).toBe(205);
    expect((await getHouseholdHistoryPage(ADVISOR, HH1, kind, { pageSize: 900, includeCompleted: true }))?.rows).toHaveLength(200);
    if (kind === "activity") expect(pages[0]?.rows[0].sf_id).toBe("HST-SYN-A-0001");
  });
  it("defaults tasks to open but counts completed rows outside the loaded window", async () => {
    const first = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    const next = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { page: 2 });
    expect(first).toMatchObject({ total: 105, meta: { openCount: 105, completedCount: 100 } });
    expect(first?.rows).toHaveLength(100); expect(next?.rows).toHaveLength(5);
    const all = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { page: 2, includeCompleted: true });
    expect(all?.rows[4].status).toBe("Not Started"); expect(all?.rows[5].status).toBe(" Completed ");
    expect(all?.snapshot).not.toBe(first?.snapshot);
  });
  it("projects assignment for authorized history pages without source owner IDs or observation timestamps", async () => {
    await owner.$executeRaw`UPDATE mirror.task SET assignment_state = 'ASSIGNED',
      assignee_sf_id = '005SYN000000001', assignee_type = 'USER', assignee_name = 'Avery Example',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz WHERE sf_id = 'HST-SYN-T-0001'`;
    await owner.$executeRaw`UPDATE mirror.task SET assignment_state = 'ASSIGNED',
      assignee_sf_id = '00GSYN000000001', assignee_type = 'QUEUE', assignee_name = 'Operations',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz WHERE sf_id = 'HST-SYN-T-0101'`;
    await owner.$executeRaw`UPDATE mirror.task SET assignment_state = 'UNASSIGNED',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz WHERE sf_id = 'HST-SYN-T-0002'`;
    const first = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    const next = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { page: 2 });
    expect(first?.rows[0]).toMatchObject({ assignment_state: "ASSIGNED", assignee_type: "USER", assignee_name: "Avery Example" });
    expect(first?.rows[1]).toMatchObject({ assignment_state: "UNASSIGNED", assignee_type: null, assignee_name: null });
    expect(first?.rows[2]).toMatchObject({ assignment_state: "UNAVAILABLE", assignee_type: null, assignee_name: null });
    expect(next?.rows[0]).toMatchObject({ assignment_state: "ASSIGNED", assignee_type: "QUEUE", assignee_name: "Operations" });
    expect(first).toMatchObject({ total: 105, meta: { openCount: 105, completedCount: 100 } });
    const response = await tasksApi(request(`page=2&snapshot=${first!.snapshot}`));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.rows[0].assignee_name).toBe("Operations");
    for (const row of [...first!.rows, ...payload.rows]) {
      expect(row).not.toHaveProperty("assignee_sf_id");
      expect(row).not.toHaveProperty("assignment_observed_at");
    }
    expect((await tasksForHouseholdSources(ADVISOR, [HH1]))[0]).not.toHaveProperty("assignment_state");
    const denied = await getHouseholdHistoryPage({ role: "ADVISOR", email: "other-history@example.invalid" }, HH1, "tasks");
    expect(denied).toBeNull();
  });
  it("invalidates an appended page after reassignment or rename without a task modification timestamp change", async () => {
    const first = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    const before = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { page: 2 });
    await owner.$executeRaw`UPDATE mirror.task SET assignment_state = 'ASSIGNED',
      assignee_sf_id = '00GSYN000000001', assignee_type = 'QUEUE', assignee_name = 'Operations',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz WHERE sf_id = 'HST-SYN-T-0101'`;
    const changed = await tasksApi(request(`page=2&snapshot=${first!.snapshot}`));
    expect(changed.status).toBe(409);
    expect(await changed.json()).not.toHaveProperty("rows");
    const assigned = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { page: 2 });
    expect(assigned?.rows[0].source_modified_at).toEqual(before?.rows[0].source_modified_at);
    await owner.$executeRaw`UPDATE mirror.task SET assignee_name = 'Operations Renamed',
      assignment_observed_at = '2026-09-24T13:00:00Z'::timestamptz WHERE sf_id = 'HST-SYN-T-0101'`;
    expect((await tasksApi(request(`page=2&snapshot=${assigned!.snapshot}`))).status).toBe(409);
    const renamed = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { page: 2 });
    expect(renamed?.rows[0].assignee_name).toBe("Operations Renamed");
    expect(renamed?.rows[0].source_modified_at).toEqual(assigned?.rows[0].source_modified_at);
    expect(renamed?.total).toBe(first?.total);
    expect(renamed?.meta.openCount).toBe(first?.meta.openCount);
    expect(renamed?.meta.completedCount).toBe(first?.meta.completedCount);
    expect(renamed?.meta.assigneeOptions).toEqual([
      { type: "QUEUE", label: "Operations Renamed", token: assigned?.meta.assigneeOptions?.[0].token },
    ]);
  });
  it("builds full-population owner options and filters later-page and completed-only matches before counting or paging", async () => {
    await assign("HST-SYN-T-0101", "00GSYN000000001", "QUEUE", "Operations");
    await assign("HST-SYN-T-0201", "00GSYN000000001", "QUEUE", "Operations");
    await assign("HST-SYN-T-0202", "005SYN000000001", "USER", "Completed-only Person");
    const all = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    expect(all?.rows).toHaveLength(100);
    expect(all?.rows.some(row => row.sf_id === "HST-SYN-T-0101")).toBe(false);
    const queue = all!.meta.assigneeOptions!.find(option => option.type === "QUEUE")!;
    const person = all!.meta.assigneeOptions!.find(option => option.type === "USER")!;
    expect(queue.label).toBe("Operations"); expect(person.label).toBe("Completed-only Person");
    const selected = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: queue.token });
    expect(selected).toMatchObject({ total: 1, pageCount: 1, meta: { openCount: 1, completedCount: 1 } });
    expect(selected?.rows.map(row => row.sf_id)).toEqual(["HST-SYN-T-0101"]);
    const selectedAll = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: queue.token, includeCompleted: true });
    expect(selectedAll).toMatchObject({ total: 2, meta: { openCount: 1, completedCount: 1 } });
    expect(selectedAll?.rows.map(row => row.sf_id)).toEqual(["HST-SYN-T-0101", "HST-SYN-T-0201"]);
    const completedPerson = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: person.token });
    expect(completedPerson).toMatchObject({ total: 0, rows: [], meta: { openCount: 0, completedCount: 1 } });
    expect((await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: person.token, includeCompleted: true }))?.total).toBe(1);
    expect(selected?.meta.assigneeOptions).toEqual(all?.meta.assigneeOptions);
    expect(selectedAll?.meta.assigneeOptions).toEqual(all?.meta.assigneeOptions);
    const payload = await (await tasksApi(request(`tasksAssignee=${queue.token}&tasksCompleted=1`))).json();
    expect(payload.total).toBe(2);
    expect(JSON.stringify(payload)).not.toContain("00GSYN000000001");
    expect(JSON.stringify(payload)).not.toContain("005SYN000000001");
  });
  it("normalizes 15/18-character owners while preserving duplicate names as distinct source identities", async () => {
    await assign("HST-SYN-T-0001", "005SYN000000001", "USER", "Alex Example");
    await assign("HST-SYN-T-0002", "005SYN000000001AAA", "USER", "Alex Example");
    await assign("HST-SYN-T-0101", "005SYN000000002", "USER", "Alex Example");
    await assign("HST-SYN-T-0102", "00GSYN000000001", "QUEUE", "Alex Example");
    const all = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    const options = all!.meta.assigneeOptions!;
    expect(options).toHaveLength(3);
    expect(new Set(options.map(option => option.token)).size).toBe(3);
    const people = options.filter(option => option.type === "USER");
    expect(people.map(option => option.label)).toEqual(["Alex Example (1)", "Alex Example (2)"]);
    expect(options.find(option => option.type === "QUEUE")?.label).toBe("Alex Example");
    expect((await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: people[0].token }))?.rows.map(row => row.sf_id))
      .toEqual(["HST-SYN-T-0001", "HST-SYN-T-0002"]);
    expect((await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: people[1].token }))?.rows.map(row => row.sf_id))
      .toEqual(["HST-SYN-T-0101"]);
    await owner.$executeRaw`UPDATE mirror.task SET assignee_name = 'Emi Rossi',
      assignment_observed_at = '2026-09-25T12:00:00Z'::timestamptz WHERE sf_id = 'HST-SYN-T-0002'`;
    const renamed = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: people[0].token });
    expect(renamed?.total).toBe(2);
    expect(renamed?.meta.assigneeOptions?.find(option => option.token === people[0].token)?.label).toBe("Emi Rossi");
  });
  it("separates source-confirmed unassigned tasks from unavailable or unresolved assignments", async () => {
    await owner.$executeRaw`UPDATE mirror.task SET assignment_state = 'UNASSIGNED',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz WHERE sf_id IN ('HST-SYN-T-0001', 'HST-SYN-T-0201')`;
    await assign("HST-SYN-T-0002", "005SYN000000001", "USER", null);
    await assign("HST-SYN-T-0003", "00GSYN000000001", "QUEUE", "Operations");
    const unassigned = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: "unassigned" });
    expect(unassigned).toMatchObject({ total: 1, meta: { openCount: 1, completedCount: 1 } });
    expect(unassigned?.rows.map(row => row.sf_id)).toEqual(["HST-SYN-T-0001"]);
    const unavailable = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: "unavailable" });
    expect(unavailable).toMatchObject({ total: 103, meta: { openCount: 103, completedCount: 99 } });
    expect(unavailable?.rows[0].sf_id).toBe("HST-SYN-T-0002");
    expect(unavailable?.rows.some(row => row.assignment_state === "UNASSIGNED")).toBe(false);
    expect(unavailable?.meta.assigneeOptions).toHaveLength(1);
    expect((await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: "unavailable", includeCompleted: true }))?.total).toBe(202);
  });
  it("never exposes out-of-book owner options and fails closed for foreign-household or unknown tokens", async () => {
    await assign("HST-SYN-T-0001", "00GSYN000000001", "QUEUE", "Operations");
    await owner.$executeRaw`INSERT INTO mirror.task (sf_id, household_sf_id, subject, assignment_state,
      assignee_sf_id, assignee_type, assignee_name, assignment_observed_at)
      VALUES ('HST-SYN-T-OTHER', ${OTHER}, 'Synthetic hidden task', 'ASSIGNED',
        '00GSYN000000001', 'QUEUE', 'Private Other Queue', '2026-09-24T12:00:00Z'::timestamptz)`;
    const hidden = await getHouseholdHistoryPage({ role: "OPERATIONS" }, OTHER, "tasks");
    const all = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    expect(all?.meta.assigneeOptions?.map(option => option.label)).toEqual(["Operations"]);
    expect(hidden?.meta.assigneeOptions?.[0].token).not.toBe(all?.meta.assigneeOptions?.[0].token);
    for (const assigneeFilter of [hidden!.meta.assigneeOptions![0].token, "f".repeat(64)]) {
      expect(await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter }))
        .toMatchObject({ total: 0, rows: [], meta: { openCount: 0, completedCount: 0 } });
      expect(await getHouseholdHistoryPage(ADVISOR, OTHER, "tasks", { assigneeFilter })).toBeNull();
    }
  });
  it("binds snapshots to assignment filters and invalidates option changes outside the selected assignment", async () => {
    await assign("HST-SYN-T-0001", "00GSYN000000001", "QUEUE", "Operations");
    const all = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    const token = all!.meta.assigneeOptions![0].token;
    const selected = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: token });
    expect(selected?.snapshot).not.toBe(all?.snapshot);
    expect((await tasksApi(request(`tasksAssignee=${token}&snapshot=${all!.snapshot}`))).status).toBe(409);
    await assign("HST-SYN-T-0205", "005SYN000000002", "USER", "New completed-only owner");
    const changed = await tasksApi(request(`tasksAssignee=${token}&snapshot=${selected!.snapshot}`));
    expect(changed.status).toBe(409);
    expect(await changed.json()).not.toHaveProperty("rows");
    const fresh = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: token });
    expect(fresh?.total).toBe(1);
    expect(fresh?.meta.assigneeOptions).toHaveLength(2);
    await assign("HST-SYN-T-0001", "005SYN000000002", "USER", "New completed-only owner");
    expect((await tasksApi(request(`tasksAssignee=${token}&snapshot=${fresh!.snapshot}`))).status).toBe(409);
    expect((await getHouseholdHistoryPage(ADVISOR, HH1, "tasks", { assigneeFilter: token }))?.total).toBe(0);
  });
  it("invalidates payload-only updates, summaries and source-key remappings", async () => {
    const first = await getHouseholdHistoryPage(ADVISOR, HH1, "email");
    await owner.$executeRaw`UPDATE mirror.email SET body = 'Revised synthetic text only' WHERE sf_id = 'HST-SYN-E-0205'`;
    expect((await emailApi(request(`page=2&snapshot=${first!.snapshot}`))).status).toBe(409);
    const before = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    await owner.$executeRaw`UPDATE mirror.task SET status = 'Not Started' WHERE sf_id = 'HST-SYN-T-0205'`;
    expect((await tasksApi(request(`page=2&snapshot=${before!.snapshot}`))).status).toBe(409);
    await assign("HST-SYN-T-0001", "005SYN000000001", "USER", "Canonical Person");
    const beforeMerge = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    await owner.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, updated_at)
      VALUES (${ID1}, 'HOUSEHOLD', now()), (${ID2}, 'HOUSEHOLD', now())`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES ('history-syn-map1', ${ID1}, 'CRM', 'household', ${HH1}, now()),
        ('history-syn-map2', ${ID2}, 'CRM', 'household', ${HH2}, now())`;
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes, status, canonical_identity_id, updated_at)
      VALUES (${CANDIDATE}, ${"51504a".padStart(64, "0")}, 'HOUSEHOLD', ${ID1}, ${ID2},
        ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], 'READY_FOR_FOLLOW_UP', ${ID1}, now())`;
    expect((await tasksApi(request(`page=2&snapshot=${beforeMerge!.snapshot}`))).status).toBe(409);
    expect((await getHouseholdHistoryPage(ADVISOR, ID2, "tasks"))?.total).toBe(106);
    expect((await getHouseholdHistoryPage(ADVISOR, HH2, "email"))?.total).toBe(205);
    const alias = await getHouseholdHistoryPage(ADVISOR, ID2, "tasks");
    const survivor = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    expect(alias?.meta.assigneeOptions).toEqual(survivor?.meta.assigneeOptions);
    expect(alias?.meta.assigneeOptions).toEqual(beforeMerge?.meta.assigneeOptions);
  });
  it("rechecks household and child RLS on every page and distinguishes empty from inaccessible", async () => {
    expect(await getHouseholdHistoryPage(ADVISOR, OTHER, "tasks")).toBeNull();
    expect(await getHouseholdHistoryPage({ role: "VIEWER" }, HH1, "email")).toBeNull();
    expect(await getHouseholdHistoryPage(ADVISOR, HH2, "email")).toMatchObject({ total: 0, rows: [], pageCount: 1 });
    const first = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    await owner.$executeRaw`UPDATE mirror.household SET lead_advisor_email = 'other-history@example.invalid' WHERE sf_id = ${HH1}`;
    const denied = await tasksApi(request(`page=2&snapshot=${first!.snapshot}`));
    expect(denied.status).toBe(404); expect(await denied.json()).not.toHaveProperty("rows");
  });
  it("preserves legacy meeting-preparation contracts and rejects replay of clamped last pages", async () => {
    expect(await tasksForHouseholdSources(ADVISOR, [HH1])).toHaveLength(205);
    expect(await emailsForHouseholdSources(ADVISOR, [HH1])).toHaveLength(50);
    expect(await activityForHouseholdSources(ADVISOR, [HH1])).toHaveLength(50);
    const first = await getHouseholdHistoryPage(ADVISOR, HH1, "tasks");
    expect((await tasksApi(request(`page=3&snapshot=${first!.snapshot}`))).status).toBe(416);
  });
});
