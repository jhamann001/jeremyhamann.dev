import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import {
  buildDestinationsView,
  fetchAssetMapDestinations,
  maskLikePipeline,
  readAssetMapDestinationContext,
  readAssetMapSourceFolderId,
  sendAssetMapDestinationWrite,
  type AssetMapDestinationContext,
  type AssetMapDestinationWrite,
} from "@/lib/data/asset-map-destinations";

const BASE = "https://pipeline.example.test";
const FOLDER = "synthetic/folder";
const OWNER = "Synthetic Owner";
const HH = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const LINK = "33333333-3333-4333-8333-333333333333";
const ACC = "44444444-4444-4444-8444-444444444444";
const ACC2 = "55555555-5555-4555-8555-555555555555";
const POS = "66666666-6666-4666-8666-666666666666";

const query = vi.fn();
const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;

function sqlOf(callIndex: number): string {
  return (query.mock.calls[callIndex][0] as string[]).join("?");
}

function rawDestination(extra: Record<string, unknown> = {}) {
  return {
    id: TARGET, owner: OWNER, target_account_type: "Individual", existing_apex_number: null, needs_to_be_opened: true,
    sources: [{ link_id: LINK, custodian: "Synthetic Custodian", account_number: "••••••••1234" }],
    suggestion: { existing_count: 1, matched_titles: ["Synthetic Title"], matched_numbers: ["SYN00001"], suggested_apex_number: "SYN00001" },
    ...extra,
  };
}

function context(accounts: AssetMapDestinationContext["accounts"]): AssetMapDestinationContext {
  return { sourceFolderId: FOLDER, accounts, overriddenPositionIds: [POS] };
}

beforeEach(() => {
  query.mockReset();
  requestMock.mockReset();
  requestMock.mockResolvedValue({ status: 200, data: { destinations: [] } });
  getIdTokenClientMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("asset-map destinations data module", () => {
  it("masks account numbers exactly like the pipeline", () => {
    expect(maskLikePipeline("000000001234")).toBe("••••••••1234");
    expect(maskLikePipeline("123-004567-890")).toBe("•••••••••7-890");
    expect(maskLikePipeline("1234")).toBe("1234");
    expect(maskLikePipeline("12")).toBe("••");
    expect(maskLikePipeline("")).toBe("");
    expect(maskLikePipeline(null)).toBeNull();
  });

  it("reads the source folder id for a household, and null when absent or empty", async () => {
    query.mockResolvedValueOnce([{ source_folder_id: "synthetic-folder" }]);
    expect(await readAssetMapSourceFolderId(tx, HH)).toBe("synthetic-folder");
    expect(sqlOf(0)).toContain("mirror.acat_asset_map_household");
    expect(query.mock.calls[0].slice(1)).toEqual([HH]);
    query.mockResolvedValueOnce([]);
    expect(await readAssetMapSourceFolderId(tx, HH)).toBeNull();
    query.mockResolvedValueOnce([{ source_folder_id: "" }]);
    expect(await readAssetMapSourceFolderId(tx, HH)).toBeNull();
    query.mockResolvedValueOnce([{ source_folder_id: null }]);
    expect(await readAssetMapSourceFolderId(tx, HH)).toBeNull();
  });

  it("reads the destination context: live accounts with pipeline-masked numbers and overridden positions", async () => {
    query
      .mockResolvedValueOnce([{ source_folder_id: "synthetic-folder" }])
      .mockResolvedValueOnce([
        { id: ACC, custodian: "Synthetic Custodian", account_number: "000000001234" },
        { id: ACC2, custodian: null, account_number: null },
      ])
      .mockResolvedValueOnce([{ id: POS }]);
    const result = await readAssetMapDestinationContext(tx, HH);
    expect(result).toEqual({
      sourceFolderId: "synthetic-folder",
      accounts: [
        { id: ACC, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234" },
        { id: ACC2, custodian: null, accountNumberMasked: null },
      ],
      overriddenPositionIds: [POS],
    });
    expect(sqlOf(1)).toContain("mirror.acat_asset_map_account");
    expect(sqlOf(1)).toContain("is_deleted IS NOT TRUE");
    expect(sqlOf(2)).toContain("override_status IS NOT NULL");
    expect(sqlOf(2)).toContain("is_deleted IS NOT TRUE");
    expect(query.mock.calls[2].slice(1)).toEqual([[ACC, ACC2]]);
    expect(JSON.stringify(result)).not.toContain("000000001234");
  });

  it("returns no context when the household has no source folder", async () => {
    query.mockResolvedValueOnce([{ source_folder_id: null }]);
    expect(await readAssetMapDestinationContext(tx, HH)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fetches destinations from the read route with the pipeline base url as audience and a 15-second timeout", async () => {
    await fetchAssetMapDestinations(BASE, FOLDER);
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const arg = requestMock.mock.calls[0][0];
    expect(arg.url).toBe(`${BASE}/api/v1/clients/synthetic%2Ffolder/destinations`);
    expect(arg.method).toBe("GET");
    expect(arg.timeout).toBe(15000);
  });

  it("returns null on a non-200 status, a malformed body, or a transport failure, logging only static markers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({ status: 403, data: { detail: "Service account not authorized" } });
    expect(await fetchAssetMapDestinations(BASE, FOLDER)).toBeNull();
    requestMock.mockResolvedValueOnce({ status: 200, data: { destinations: [{ owner: OWNER }] } });
    expect(await fetchAssetMapDestinations(BASE, FOLDER)).toBeNull();
    requestMock.mockRejectedValueOnce(new Error("synthetic transport failure"));
    expect(await fetchAssetMapDestinations(BASE, FOLDER)).toBeNull();
    expect(error.mock.calls).toEqual([
      ["[asset-map] destinations_status=403"],
      ["[asset-map] destinations_malformed"],
      ["[asset-map] destinations_transport_failed"],
    ]);
  });

  it("maps destinations and joins each source to its account by custodian and masked number", async () => {
    requestMock.mockResolvedValueOnce({ status: 200, data: { destinations: [rawDestination()] } });
    const raw = await fetchAssetMapDestinations(BASE, FOLDER);
    expect(raw).not.toBeNull();
    const view = buildDestinationsView(raw!, context([
      { id: ACC, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234" },
      { id: ACC2, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234" },
    ]));
    expect(view.destinations).toEqual([{
      id: TARGET, owner: OWNER, targetAccountType: "Individual", existingApexNumber: null, needsToBeOpened: true,
      existingCount: 1, suggestedApexNumber: "SYN00001",
      sources: [{ linkId: LINK, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234", accountId: ACC }],
    }]);
    expect(view.accountNumbers).toEqual({ [ACC]: "••••••••1234", [ACC2]: "••••••••1234" });
    expect(view.overriddenPositionIds).toEqual([POS]);
  });

  it("leaves a source unmatched when no live account has the same custodian and masked number", async () => {
    requestMock.mockResolvedValueOnce({ status: 200, data: { destinations: [rawDestination()] } });
    const raw = await fetchAssetMapDestinations(BASE, FOLDER);
    const view = buildDestinationsView(raw!, context([
      { id: ACC, custodian: "Other Custodian", accountNumberMasked: "••••••••1234" },
      { id: ACC2, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••9999" },
    ]));
    expect(view.destinations[0].sources[0].accountId).toBeNull();
  });

  it("keeps only the existing count and suggested Apex number from the suggestion", async () => {
    requestMock.mockResolvedValueOnce({ status: 200, data: { destinations: [rawDestination()] } });
    const raw = await fetchAssetMapDestinations(BASE, FOLDER);
    const json = JSON.stringify(raw);
    expect(raw![0].existingCount).toBe(1);
    expect(raw![0].suggestedApexNumber).toBe("SYN00001");
    expect(json).not.toContain("matched_titles");
    expect(json).not.toContain("matchedTitles");
    expect(json).not.toContain("Synthetic Title");
  });

  it("sends add, needs-to-be-opened, type, and remove to the destination routes", async () => {
    const cases: [AssetMapDestinationWrite, string, string, unknown][] = [
      [{ kind: "add", sourceFolderId: FOLDER, owner: OWNER, targetAccountType: "Individual" }, "POST", `/api/clients/synthetic%2Ffolder/destinations`, { owner: OWNER, target_account_type: "Individual" }],
      [{ kind: "needsOpen", targetId: TARGET, needsToBeOpened: false }, "PATCH", `/api/destinations/${TARGET}`, { needs_to_be_opened: false }],
      [{ kind: "type", targetId: TARGET, targetAccountType: "Roth IRA" }, "PATCH", `/api/destinations/${TARGET}`, { target_account_type: "Roth IRA" }],
      [{ kind: "remove", targetId: TARGET }, "DELETE", `/api/destinations/${TARGET}`, undefined],
    ];
    for (const [req, method, path, data] of cases) {
      requestMock.mockClear();
      await sendAssetMapDestinationWrite(BASE, req);
      const arg = requestMock.mock.calls[0][0];
      expect(arg.method).toBe(method);
      expect(arg.url).toBe(`${BASE}${path}`);
      expect(arg.data).toEqual(data);
      expect(arg.timeout).toBe(15000);
    }
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
  });

  it("sends a move to an existing destination and to a new Individual destination", async () => {
    await sendAssetMapDestinationWrite(BASE, { kind: "reassign", linkId: LINK, targetAccountId: TARGET });
    await sendAssetMapDestinationWrite(BASE, { kind: "reassignNew", linkId: LINK, sourceFolderId: FOLDER, newOwner: OWNER });
    const [existing, created] = requestMock.mock.calls.map((c) => c[0]);
    expect(existing).toMatchObject({ method: "POST", url: `${BASE}/api/source-accounts/reassign`, data: { link_id: LINK, target_account_id: TARGET } });
    expect(created).toMatchObject({
      method: "POST",
      url: `${BASE}/api/source-accounts/reassign`,
      data: { link_id: LINK, source_folder_id: FOLDER, new_owner: OWNER, new_target_account_type: "Individual" },
    });
  });

  it("maps 2xx to the body, 5xx and transport failure to unavailable, and other statuses to rejected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const req: AssetMapDestinationWrite = { kind: "remove", targetId: TARGET };
    requestMock.mockResolvedValueOnce({ status: 200, data: { id: TARGET, deleted: true } });
    expect(await sendAssetMapDestinationWrite(BASE, req)).toEqual({ ok: true, body: { id: TARGET, deleted: true } });
    for (const status of [400, 403, 404]) {
      requestMock.mockResolvedValueOnce({ status, data: { detail: "Destination not found" } });
      expect(await sendAssetMapDestinationWrite(BASE, req)).toEqual({ ok: false, reason: "rejected" });
    }
    for (const status of [500, 503]) {
      requestMock.mockResolvedValueOnce({ status, data: { detail: "synthetic internal detail" } });
      expect(await sendAssetMapDestinationWrite(BASE, req)).toEqual({ ok: false, reason: "unavailable" });
    }
    requestMock.mockRejectedValueOnce(new Error("synthetic timeout"));
    expect(await sendAssetMapDestinationWrite(BASE, req)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("never logs the url, token, body, folder id, owner, or an account number", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({ status: 403, data: { detail: OWNER } });
    await fetchAssetMapDestinations(BASE, FOLDER);
    requestMock.mockResolvedValueOnce({ status: 200, data: { destinations: [{ owner: OWNER, sources: [{ account_number: "000000001234" }] }] } });
    await fetchAssetMapDestinations(BASE, FOLDER);
    requestMock.mockRejectedValueOnce(new Error(`${BASE} ${FOLDER} ${OWNER} 1234`));
    await fetchAssetMapDestinations(BASE, FOLDER);
    const add: AssetMapDestinationWrite = { kind: "add", sourceFolderId: FOLDER, owner: OWNER, targetAccountType: "Individual" };
    for (const status of [400, 403, 404, 500, 503]) {
      requestMock.mockResolvedValueOnce({ status, data: { detail: `${OWNER} 000000001234` } });
      await sendAssetMapDestinationWrite(BASE, add);
    }
    requestMock.mockRejectedValueOnce(new Error(`${BASE} ${FOLDER} ${OWNER} 1234`));
    await sendAssetMapDestinationWrite(BASE, add);
    expect(error).toHaveBeenCalled();
    for (const arg of error.mock.calls.flat()) {
      const text = String(arg);
      for (const secret of [BASE, FOLDER, encodeURIComponent(FOLDER), OWNER, "1234", "Bearer"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("does not import the ingest connection or the mirror module", () => {
    const source = readFileSync("lib/data/asset-map-destinations.ts", "utf8");
    expect(source).not.toContain("@/lib/ingest");
    expect(source).not.toContain('@/lib/data/asset-map"');
  });
});
