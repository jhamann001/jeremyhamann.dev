import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, authSpy, previewSpy, notFoundSpy, redirectSpy } = vi.hoisted(() => ({
  scopeSpy: vi.fn(),
  authSpy: vi.fn(),
  previewSpy: vi.fn(),
  notFoundSpy: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirectSpy: vi.fn(() => { throw new Error("REDIRECT"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/navigation", () => ({ notFound: notFoundSpy, redirect: redirectSpy, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/operations/fee-requests" }));
vi.mock("@/lib/flags", async (original) => ({
  ...(await original<typeof import("@/lib/flags")>()),
  operationsFeeRequestsPreviewEnabled: previewSpy,
}));
vi.mock("@/app/(authenticated)/operations/fee-requests/actions", () => ({
  searchOperationsFeeClients: vi.fn(),
  submitOperationsFeeRequest: vi.fn(),
}));
vi.mock("@/components/operations", async () => ({
  ...(await import("@/components/operations/FeeRequestIntake")),
  FeeRequestWorkflow: () => null,
}));
vi.mock("@/components/operations/FeeRequestWorkflow", () => ({ FeeRequestWorkflow: () => null }));

import OperationsFeeRequestsPage from "@/app/(authenticated)/operations/fee-requests/page";
import { operationsFeeRequestPageData } from "@/lib/data/operations-fee-requests";
import { EXCEPTION_TYPES } from "@/lib/operations/fee-request";

const IDENTITY = { role: "OPERATIONS", email: "operator@example.test" };
const OLDER_ID = "cmfee_older_selected_0001";

function request(id: string, kind: "FEE_CREDIT" | "LARGE_HOUSEHOLD_EXCEPTION" = "FEE_CREDIT") {
  return {
    id, kind, status: "PENDING", scope: "CLIENT", client_sf_id: "003SYNTHETIC001AA",
    account_ids: [], fee_types: ["Transaction"], fee_amount: null,
    waiver_start: new Date("2026-09-01T00:00:00Z"), waiver_duration_months: 3,
    indefinite_duration: false, submitted_by_name: "Synthetic operator",
    submitted_by_email: "operator@example.test", submitted_at: new Date("2026-09-14T12:00:00Z"),
    reason: "Synthetic request <script>not executable</script>", relevant_ticket_refs: ["TICKET-TEST"],
    reviewed_by_name: null, reviewed_by_email: null, reviewed_at: null,
    credited_at: null, apex_request_id: null, legacy_apex_request_text: null,
    legacy_household_sf_id: null, legacy_client_name: null,
    completed_by_name: null, completed_by_email: null, completed_at: null, events: [],
  };
}

function recentRequests() {
  return Array.from({ length: 100 }, (_, index) => request(`cmfee_recent_request_${String(index).padStart(4, "0")}`));
}

let tx: {
  operationsFeeRequest: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  $queryRaw: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  authSpy.mockResolvedValue({ user: IDENTITY });
  previewSpy.mockReturnValue(true);
  tx = {
    operationsFeeRequest: {
      findMany: vi.fn().mockImplementation(async () => recentRequests()),
      findUnique: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([
        { status: "PENDING", _count: { _all: 132 } },
        { status: "APPROVED", _count: { _all: 5 } },
      ]),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  scopeSpy.mockImplementation(async (_identity: unknown, fn: (value: typeof tx) => unknown) => fn(tx));
});

describe("Operations request deep-link reads", () => {
  it.each(["", "short", "a".repeat(65), `${OLDER_ID}\n`, `${OLDER_ID}\r`, `${OLDER_ID}\u2028`, `${OLDER_ID}\u2029`])(
    "rejects invalid IDs at the data boundary before opening a transaction: %j", async (value) => {
      await expect(operationsFeeRequestPageData(IDENTITY, value)).rejects.toThrow("invalid_operations_request_id");
      expect(scopeSpy).not.toHaveBeenCalled();
      expect(tx.operationsFeeRequest.findMany).not.toHaveBeenCalled();
      expect(tx.operationsFeeRequest.findUnique).not.toHaveBeenCalled();
    },
  );

  it("retains the latest-100 history bound and independent whole-queue counts", async () => {
    const data = await operationsFeeRequestPageData(IDENTITY);
    expect(data.requests).toHaveLength(100);
    expect(data.counts).toEqual({ pending: 132, approved: 5, credited: 0, closed: 0, total: 137 });
    expect(tx.operationsFeeRequest.findMany).toHaveBeenCalledExactlyOnceWith({
      orderBy: { submitted_at: "desc" }, take: 100,
      include: { events: { orderBy: { at: "asc" } } },
    });
    expect(tx.operationsFeeRequest.findUnique).not.toHaveBeenCalled();
  });

  it("loads only one exact older request inside the same authenticated scope", async () => {
    tx.operationsFeeRequest.findUnique.mockResolvedValue(request(OLDER_ID));
    const data = await operationsFeeRequestPageData(IDENTITY, OLDER_ID);
    expect(scopeSpy).toHaveBeenCalledExactlyOnceWith(
      IDENTITY, expect.any(Function), { maxWait: 10_000, timeout: 15_000 },
    );
    expect(tx.operationsFeeRequest.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: OLDER_ID }, include: { events: { orderBy: { at: "asc" } } },
    });
    expect(tx.operationsFeeRequest.findMany).toHaveBeenCalledTimes(1);
    expect(tx.operationsFeeRequest.findMany.mock.calls[0][0]).toHaveProperty("take", 100);
    expect(data.requests).toHaveLength(101);
    expect(data.requests[0].id).toBe(OLDER_ID);
    expect(data.counts.total).toBe(137);
  });

  it("moves a selected recent request first without duplicating it or adding an archive query", async () => {
    const selectedId = recentRequests()[90].id;
    const data = await operationsFeeRequestPageData(IDENTITY, selectedId);
    expect(data.requests).toHaveLength(100);
    expect(data.requests[0].id).toBe(selectedId);
    expect(data.requests.filter((row) => row.id === selectedId)).toHaveLength(1);
    expect(tx.operationsFeeRequest.findUnique).not.toHaveBeenCalled();
  });
});

describe("Operations request deep-link page authorization and rendering", () => {
  it("redirects an unauthenticated request before reading anything", async () => {
    authSpy.mockResolvedValue(null);
    await expect(OperationsFeeRequestsPage({ searchParams: Promise.resolve({ request: OLDER_ID }) })).rejects.toThrow("REDIRECT");
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "unknown"])("denies %s before any data read", async (role) => {
    authSpy.mockResolvedValue({ user: { ...IDENTITY, role } });
    await expect(OperationsFeeRequestsPage({ searchParams: Promise.resolve({ request: OLDER_ID }) })).rejects.toThrow("NOT_FOUND");
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("keeps the feature gate before any data read", async () => {
    previewSpy.mockReturnValue(false);
    await expect(OperationsFeeRequestsPage({ searchParams: Promise.resolve({ request: OLDER_ID }) })).rejects.toThrow("NOT_FOUND");
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it.each(["", "short", "a".repeat(65), "<script>not an id</script>", `${OLDER_ID} `, `${OLDER_ID}\n`, `${OLDER_ID}\r`, `${OLDER_ID}\u2028`, `${OLDER_ID}\u2029`, [OLDER_ID, OLDER_ID], []])(
    "rejects an invalid or ambiguous ID with a generic not-found response: %j",
    async (value) => {
      await expect(OperationsFeeRequestsPage({ searchParams: Promise.resolve({ request: value }) })).rejects.toThrow("NOT_FOUND");
      expect(scopeSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "hidden by RLS"])("does not distinguish a %s request", async () => {
    tx.operationsFeeRequest.findUnique.mockResolvedValue(null);
    await expect(OperationsFeeRequestsPage({ searchParams: Promise.resolve({ request: OLDER_ID }) })).rejects.toThrow("NOT_FOUND");
    expect(notFoundSpy).toHaveBeenCalledExactlyOnceWith();
  });

  it("renders only the exact older linked request open, with escaped details and a safe return link", async () => {
    tx.operationsFeeRequest.findUnique.mockResolvedValue(request(OLDER_ID, "LARGE_HOUSEHOLD_EXCEPTION"));
    const html = renderToStaticMarkup(await OperationsFeeRequestsPage({ searchParams: Promise.resolve({ request: OLDER_ID }) }));
    expect(html).toContain(`id="request-${OLDER_ID}" data-request-id="${OLDER_ID}" open=""`);
    expect(html).not.toContain(`id="request-${recentRequests()[0].id}"`);
    expect(tx.operationsFeeRequest.findMany).not.toHaveBeenCalled();
    expect(html).toContain("$10M+ household billing exception");
    expect(html).toContain("Back to requests");
    expect(html).toContain("Synthetic request &lt;script&gt;not executable&lt;/script&gt;");
    expect(html).not.toContain("<script>not executable</script>");
    expect(html).toContain("Slack notifications are disabled in development");
  });

  it("supplies a server-created UUID through the intake's hidden stable submission key", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ records: [], total: 0n, pending: 0n, approved: 0n, credited: 0n, closed: 0n, snapshot: "a".repeat(32) }]);
    const html = renderToStaticMarkup(await OperationsFeeRequestsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/name="submissionKey" value="[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"/);
    const intake = fs.readFileSync(path.join(process.cwd(), "components/operations/FeeRequestIntake.tsx"), "utf8");
    expect(intake).toContain('name="submissionKey" value={submissionKey}');
    expect(intake).not.toContain("randomUUID");
    expect(EXCEPTION_TYPES.find((type) => type.value === "LARGE_HOUSEHOLD_EXCEPTION")?.label).toBe("$10M+ household billing exception");
  });

  it("returns an obsolete numbered window to the first filtered page with an explanation", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ records: [], total: 0n, pending: 0n, approved: 0n, credited: 0n, closed: 0n, snapshot: "a".repeat(32) }]);
    await expect(OperationsFeeRequestsPage({ searchParams: Promise.resolve({ page: "51", q: "Synthetic", status: "APPROVED" }) })).rejects.toThrow("REDIRECT");
    expect(redirectSpy).toHaveBeenCalledWith("/operations/fee-requests?status=APPROVED&q=Synthetic&message=history-refreshed");
  });
});
