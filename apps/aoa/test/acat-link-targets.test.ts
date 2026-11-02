import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), clients: vi.fn(), households: vi.fn(), transfers: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ listClients: mocks.clients }));
vi.mock("@/lib/data/household-picker", () => ({ listHouseholdPickerTargets: mocks.households }));
vi.mock("@/lib/data/transfers", () => ({ listTransfers: mocks.transfers }));
import { loadLinkTargets } from "@/app/(authenticated)/acat-tracking/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "picker@example.invalid" } });
  mocks.clients.mockResolvedValue([{ sf_id: "client", name: "Tom Delgado", household_id: "household", household_name: "Smith Household" }]);
  mocks.households.mockResolvedValue([{ sf_id: "household", name: "Smith Household", source_names: ["Tom Delgado Household", "Prior label"] }]);
  mocks.transfers.mockResolvedValue([
    { id: "open", client_first_name: "Tom", client_last_name: "Delgado", stage: "IN_TRANSFER", client_sf_id: "client", household_sf_id: "household", acat_transfer_id: null, acat_record_id: null },
    { id: "funded", stage: "FUNDED", acat_transfer_id: null, acat_record_id: null },
    { id: "linked", stage: "IN_TRANSFER", acat_transfer_id: null, acat_record_id: "record" },
  ]);
});

describe("ACAT target load uses the bounded household identity read", () => {
  it("preserves aliases, canonical IDs and attachable-transfer filtering for a permitted operator", async () => {
    expect(await loadLinkTargets()).toEqual({
      ok: true,
      clients: [{ sfId: "client", name: "Tom Delgado", householdId: "household", householdName: "Smith Household" }],
      households: [{ sfId: "household", name: "Smith Household", sourceNames: ["Tom Delgado Household", "Prior label"] }],
      openTransfers: [{ id: "open", name: "Tom Delgado", stage: "IN_TRANSFER", clientSfId: "client", householdSfId: "household" }],
    });
    expect(mocks.households).toHaveBeenCalledExactlyOnceWith({ role: "OPERATIONS", email: "picker@example.invalid" });
  });

  it.each(["clients", "households", "transfers"] as const)("logs only a static branch marker when %s fails", async branch => {
    mocks[branch].mockRejectedValueOnce({ code: "P2010", meta: { code: "57014" }, message: "private query must not be logged" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await loadLinkTargets()).toEqual({ ok: false, reason: "error" });
      expect(log).toHaveBeenCalledExactlyOnceWith(`[acat-link] load_targets_failed:${branch}`);
    } finally { log.mockRestore(); }
  });

  it("does not load dependencies for an advisor", async () => {
    mocks.auth.mockResolvedValueOnce({ user: { role: "ADVISOR", email: "picker@example.invalid" } });
    expect(await loadLinkTargets()).toEqual({ ok: false, reason: "forbidden" });
    expect(mocks.clients).not.toHaveBeenCalled();
    expect(mocks.households).not.toHaveBeenCalled();
    expect(mocks.transfers).not.toHaveBeenCalled();
  });
});
