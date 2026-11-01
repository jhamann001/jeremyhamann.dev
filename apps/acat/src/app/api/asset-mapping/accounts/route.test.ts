import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { GET } from "./route";
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gcp-auth", () => ({ getAuthenticatedClient: vi.fn().mockResolvedValue({ request }) }));
const { prisma } = await import("@/lib/prisma");
const get = (query: string) => GET(new Request(`http://localhost/api/asset-mapping/accounts?${query}`) as Parameters<typeof GET>[0]);
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("GCP_ASSET_MAPPING_URL", "https://synthetic-mapping.example.test"); });
afterEach(() => vi.unstubAllEnvs());

describe("mapping account discovery", () => {
  it("returns separate registrations with masked identifiers and no positions", async () => {
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({ id: "REC" } as never);
    request.mockResolvedValue({ status: 200, data: { accounts: [
      { id: "IRA", account_holder: "Synthetic Owner", account_registration: "Traditional IRA", investor_number: "INV123456", account_number: null, position_count: 2 },
      { id: "ROTH", account_holder: "Synthetic Owner", account_registration: "Roth IRA", investor_number: "INV123456", account_number: null, position_count: 4 },
    ], truncated: true } });
    const response = await get("acatId=REC&q=Synthetic");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[1]).toMatchObject({ registration: "Roth IRA", investorNumberLast4: "3456", accountNumberLast4: null });
    expect(JSON.stringify(body)).not.toContain("INV123456");
    expect(body.truncated).toBe(true);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("bounds search and requires a live Tracker record", async () => {
    expect((await get("acatId=REC&q=x")).status).toBe(400);
    expect((await get("q=Synthetic")).status).toBe(400);
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(null);
    expect((await get("acatId=missing&q=Synthetic")).status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not expose upstream errors or return malformed account lists", async () => {
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({ id: "REC" } as never);
    request.mockResolvedValue({ status: 200, data: {} });
    expect((await get("acatId=REC&q=Synthetic")).status).toBe(502);
  });
});
