import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
import { searchHouseholdEmails } from "@/lib/data/household-email-search";
import { getHouseholdHistoryPage } from "@/lib/data/household-history";
import { emailsForHouseholdSources } from "@/lib/data/emails";
import { POST as searchApi } from "@/app/api/navigation/household-email/search/route";
import { POST as ingestEmails } from "@/app/api/ingest/emails/route";

// ticket content search against synthetic PostgreSQL and real RLS. Every row is
// invented (ESR-SYN-*, example.invalid / example.test). No client data.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "search-advisor@example.invalid" };
const OPS = { role: "OPERATIONS", email: "search-ops@example.invalid" };
const HH = "001XRR931615928", OTHER = "001IOU721216075";
const INGEST_TOKEN = "synthetic-email-search-ingest-token";

const api = (body: Record<string, unknown>) => searchApi(new Request("https://example.test/api/navigation/household-email/search", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

gated("ticket household email content search against synthetic PostgreSQL and RLS", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.email WHERE sf_id LIKE 'ESR-SYN-%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${HH}, ${OTHER})`;
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityId" LIKE 'esr-syn-run-%'`;
  }
  async function email(id: string, household: string, subject: string | null, body: string | null, sent: string | null) {
    await owner.$executeRaw`INSERT INTO mirror.email (sf_id, household_sf_id, subject, body, sent_at)
      VALUES (${id}, ${household}, ${subject}, ${body}, ${sent}::timestamptz)`;
  }

  beforeAll(async () => {
    const cleanupUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!cleanupUrl || !process.env.DATABASE_URL || !process.env.INGEST_DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    const expected = new URL(cleanupUrl);
    for (const raw of [cleanupUrl, process.env.DATABASE_URL, process.env.INGEST_DATABASE_URL]) {
      const parsed = new URL(raw);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.host !== expected.host || !parsed.port || ['host','hostaddr','service','servicefile'].some(key => parsed.searchParams.has(key)) || parsed.pathname !== expected.pathname ||
        !(parsed.pathname === "/aoa_rollout_synthetic" || parsed.pathname === "/aoa_pagination_synthetic" ||
          (process.env.CI === "true" && parsed.pathname === "/aoa"))) throw new Error("isolated_synthetic_database_required");
    }
    if (expected.username !== "aoa" || new URL(process.env.DATABASE_URL).username !== "app_rw" || new URL(process.env.INGEST_DATABASE_URL).username !== "ingest_rw") throw new Error("synthetic_database_roles_required");
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
  });
  beforeEach(async () => {
    await cleanup();
    auth.mockResolvedValue({ user: ADVISOR, navigationScope: "e".repeat(64) });
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${HH}, 'Invented search household', ${ADVISOR.email}),
        (${OTHER}, 'Invented other book', 'other-search@example.invalid')`;
  });
  afterAll(async () => { await cleanup(); await owner.$disconnect(); });

  it("searches every stored email server-side, including rows beyond the first history page", async () => {
    for (let i = 0; i < 130; i += 1) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      await email(`ESR-SYN-P${String(i).padStart(3, "0")}`, HH, `Synthetic routine ${i}`, `Routine synthetic note ${i}`, `2026-0${1 + Math.floor(i / 28)}-${day}T12:00:00Z`);
    }
    await email("ESR-SYN-OLDEST", HH, "Synthetic archive", "Contains the unusual word quokkasynth", "2025-12-31T12:00:00Z");
    const history = await getHouseholdHistoryPage(ADVISOR, HH, "email", { page: 1 });
    expect(history?.rows.some(row => row.sf_id === "ESR-SYN-OLDEST")).toBe(false);
    const result = await searchHouseholdEmails(ADVISOR, HH, "QUOKKASYNTH");
    expect(result?.rows.map(row => row.sf_id)).toEqual(["ESR-SYN-OLDEST"]);
    expect(result?.searched).toBe(131);

    const all = await searchHouseholdEmails(ADVISOR, HH, "synthetic");
    expect(all?.total).toBe(history?.total);
    expect(all?.pageCount).toBe(3);
    const seen: string[] = [];
    for (let page = 1; page <= (all?.pageCount ?? 0); page += 1) {
      const next = await searchHouseholdEmails(ADVISOR, HH, "synthetic", { page });
      expect(next?.snapshot).toBe(all?.snapshot);
      seen.push(...(next?.rows ?? []).map(row => row.sf_id));
    }
    expect(seen).toHaveLength(131);
    expect(new Set(seen).size).toBe(131);
  });

  it("matches subject or retained body literally and case-insensitively, including null metadata", async () => {
    await email("ESR-SYN-N1", HH, null, "Body only mentions Wombatsynth", null);
    await email("ESR-SYN-N2", HH, "Subject only WOMBATSYNTH", null, "2026-02-01T12:00:00Z");
    await email("ESR-SYN-N3", HH, null, null, null);
    const result = await searchHouseholdEmails(ADVISOR, HH, "wombatsynth");
    expect(result?.rows.map(row => row.sf_id)).toEqual(["ESR-SYN-N2", "ESR-SYN-N1"]);
    expect(result?.searched).toBe(3);
  });

  it("treats %, _, backslashes and regex metacharacters as literal text", async () => {
    await email("ESR-SYN-S1", HH, "Synthetic fee", "Fee is 50% this quarter", "2026-03-01T12:00:00Z");
    await email("ESR-SYN-S2", HH, "Synthetic id", "Reference a_b only", "2026-03-02T12:00:00Z");
    await email("ESR-SYN-S3", HH, "Synthetic regex", "Literal x.*y and (p|q) and back\\slash", "2026-03-03T12:00:00Z");
    await email("ESR-SYN-S4", HH, "Synthetic plain", "Fifty percent and aXb and xzzy", "2026-03-04T12:00:00Z");
    const ids = async (term: string) => (await searchHouseholdEmails(ADVISOR, HH, term))?.rows.map(row => row.sf_id);
    expect(await ids("50%")).toEqual(["ESR-SYN-S1"]);
    expect(await ids("0%")).toEqual(["ESR-SYN-S1"]);
    expect(await ids("a_b")).toEqual(["ESR-SYN-S2"]);
    expect(await ids("_b")).toEqual(["ESR-SYN-S2"]);
    expect(await ids("x.*y")).toEqual(["ESR-SYN-S3"]);
    expect(await ids("(p|q)")).toEqual(["ESR-SYN-S3"]);
    expect(await ids("back\\slash")).toEqual(["ESR-SYN-S3"]);
    expect(await ids("$^")).toEqual([]);
  });

  it("returns an empty, bounded result for no matches and rejects unsearchable terms", async () => {
    await email("ESR-SYN-Z1", HH, "Synthetic", "Nothing relevant", "2026-03-01T12:00:00Z");
    expect(await searchHouseholdEmails(ADVISOR, HH, "no-such-synthetic-term")).toMatchObject({ rows: [], total: 0, pageCount: 1, searched: 1 });
    expect(await searchHouseholdEmails(ADVISOR, HH, "x")).toBeNull();
    expect(await searchHouseholdEmails(ADVISOR, HH, "a\u0000b")).toBeNull();
  });

  it("finds rows ingested through old (omitted keys) and new (explicit null) payload shapes", async () => {
    vi.stubEnv("INGEST_TOKEN", INGEST_TOKEN);
    const response = await ingestEmails(new Request("https://example.test/api/ingest/emails", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({ source: "crm", run_id: "esr-syn-run-1", items: [
        { sf_id: "ESR-SYN-OLD", household_sf_id: HH, subject: "Old shape platypussynth" },
        { sf_id: "ESR-SYN-NEW", household_sf_id: HH, subject: null, body: "New shape platypussynth", sent_at: null, last_modified_at: null },
        { sf_id: "ESR-SYN-FULL", household_sf_id: HH, subject: "Full", body: "Full shape platypussynth",
          sent_at: "2026-04-01T12:00:00Z", last_modified_at: "2026-04-01T12:05:00Z" },
      ] }),
    }));
    expect(response.status).toBe(200);
    vi.unstubAllEnvs();
    const result = await searchHouseholdEmails(ADVISOR, HH, "platypussynth");
    expect(result?.rows.map(row => row.sf_id).sort()).toEqual(["ESR-SYN-FULL", "ESR-SYN-NEW", "ESR-SYN-OLD"]);
    expect(result?.rows.find(row => row.sf_id === "ESR-SYN-OLD")).toMatchObject({ body: null, sent_at: null });
  });

  it("never matches, returns or displays a logged Bcc line, including folded continuations", async () => {
    await email("ESR-SYN-B1", HH, "Synthetic logged headers",
      "To: visible-syn@example.test\nBcc: hidden-syn@example.test,\n   folded-syn@example.test\nBCC : upper-syn@example.test\nBody keeps going echidnasynth",
      "2026-05-01T12:00:00Z");
    for (const term of ["hidden-syn", "folded-syn", "upper-syn", "bcc"]) {
      expect((await searchHouseholdEmails(ADVISOR, HH, term))?.total).toBe(0);
    }
    const found = await searchHouseholdEmails(ADVISOR, HH, "echidnasynth");
    const body = found?.rows[0]?.body ?? "";
    expect(body).toContain("To: visible-syn@example.test");
    expect(body).toContain("Body keeps going echidnasynth");
    expect(body.toLowerCase()).not.toContain("bcc");
    for (const value of ["hidden-syn", "folded-syn", "upper-syn"]) expect(body).not.toContain(value);
    const history = await getHouseholdHistoryPage(ADVISOR, HH, "email", { page: 1 });
    expect(history?.rows[0]?.body).toBe(body);
    const legacy = await emailsForHouseholdSources(ADVISOR, [HH]);
    expect(legacy[0]?.body).toBe(body);
    await email("ESR-SYN-B2", HH, "Synthetic only bcc", "Bcc: only-hidden-syn@example.test", "2026-05-02T12:00:00Z");
    expect((await getHouseholdHistoryPage(ADVISOR, HH, "email", { page: 1 }))?.rows.find(row => row.sf_id === "ESR-SYN-B2")?.body).toBeNull();
  });

  it.each(["\n", "\r\n", "\r"])("strips legacy headers and folded recipients with %j line endings on every read path", async newline => {
    await email("ESR-SYN-LINE", HH, "Synthetic line endings", [
      "To: visible-lines@example.invalid", "Bcc: hidden-lines@example.invalid,",
      "\tfolded-lines@example.invalid", "Visible body echidnalinesynth",
    ].join(newline), "2026-05-03T12:00:00Z");
    for (const term of ["hidden-lines", "folded-lines"]) expect((await searchHouseholdEmails(ADVISOR, HH, term))?.total).toBe(0);
    const body = (await searchHouseholdEmails(ADVISOR, HH, "echidnalinesynth"))?.rows[0]?.body;
    expect(body).toContain("To: visible-lines@example.invalid");
    expect(body).toContain("Visible body echidnalinesynth");
    expect(body).not.toContain("hidden-lines"); expect(body).not.toContain("folded-lines");
    expect((await getHouseholdHistoryPage(ADVISOR, HH, "email", { page: 1 }))?.rows[0]?.body).toBe(body);
    expect((await emailsForHouseholdSources(ADVISOR, [HH]))[0]?.body).toBe(body);
  });

  it("respects RLS exactly: own book only for advisors, nothing for Viewer or an unroled caller", async () => {
    await email("ESR-SYN-R1", HH, "Synthetic mine", "Shared term koalasynth", "2026-06-01T12:00:00Z");
    await email("ESR-SYN-R2", OTHER, "Synthetic theirs", "Shared term koalasynth", "2026-06-02T12:00:00Z");
    expect((await searchHouseholdEmails(ADVISOR, HH, "koalasynth"))?.rows.map(row => row.sf_id)).toEqual(["ESR-SYN-R1"]);
    expect(await searchHouseholdEmails(ADVISOR, OTHER, "koalasynth")).toBeNull();
    expect(await searchHouseholdEmails({ role: "VIEWER", email: "viewer@example.invalid" }, HH, "koalasynth")).toBeNull();
    expect(await searchHouseholdEmails({ role: "", email: null }, HH, "koalasynth")).toBeNull();
    expect((await searchHouseholdEmails(OPS, OTHER, "koalasynth"))?.rows.map(row => row.sf_id)).toEqual(["ESR-SYN-R2"]);
  });

  it("revokes mid-session: a moved household, a role change and a lost session all stop results", async () => {
    await email("ESR-SYN-V1", HH, "Synthetic revocable", "Revocable term dingosynth", "2026-07-01T12:00:00Z");
    const first = await api({ household: HH, q: "dingosynth" });
    expect(first.status).toBe(200);
    expect((await first.json()).total).toBe(1);
    await owner.$executeRaw`UPDATE mirror.household SET lead_advisor_email = 'reassigned-search@example.invalid' WHERE sf_id = ${HH}`;
    expect((await api({ household: HH, q: "dingosynth" })).status).toBe(404);
    await owner.$executeRaw`UPDATE mirror.household SET lead_advisor_email = ${ADVISOR.email} WHERE sf_id = ${HH}`;
    auth.mockResolvedValueOnce({ user: { role: "VIEWER", email: ADVISOR.email }, navigationScope: "e".repeat(64) });
    expect((await api({ household: HH, q: "dingosynth" })).status).toBe(404);
    auth.mockResolvedValueOnce(null);
    expect((await api({ household: HH, q: "dingosynth" })).status).toBe(401);
  });

  it("rejects a stale page after the matching set changes (consistent snapshots)", async () => {
    for (let i = 0; i < 60; i += 1) await email(`ESR-SYN-C${String(i).padStart(2, "0")}`, HH, "Synthetic", `Drift term bilbysynth ${i}`, "2026-08-01T12:00:00Z");
    const first = await (await api({ household: HH, q: "bilbysynth" })).json();
    expect(first.pageCount).toBe(2);
    expect((await api({ household: HH, q: "bilbysynth", page: 2, snapshot: first.snapshot })).status).toBe(200);
    await owner.$executeRaw`UPDATE mirror.email SET body = 'Edited synthetic text' WHERE sf_id = 'ESR-SYN-C00'`;
    expect((await api({ household: HH, q: "bilbysynth", page: 2, snapshot: first.snapshot })).status).toBe(409);
  });
});
