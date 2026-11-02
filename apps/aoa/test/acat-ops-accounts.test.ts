import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: vi.fn() }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));

const { requestMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: vi.fn(async () => ({ request: requestMock })) };
  });
  return { requestMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import { AcatBookView } from "@/components/transfers/AcatBookView";
import { AcatStatusCard } from "@/components/transfers/AcatStatusCard";
import { maskBookAccountForFee, mapAcatBookRow, type AcatBookRow } from "@/lib/data/acat-book";
import {
  fetchAcatList,
  fetchAcatOpsBook,
  fetchAcatOpsList,
  getAcatOpsStatusByRecordId,
  getAcatStatus,
  getAcatStatusByRecordId,
  type AcatStatus,
} from "@/lib/data/acat-status";

const BASE = "https://transfers.jeremyhamann.dev";

function bookRow(): AcatBookRow {
  const mapped = mapAcatBookRow({
    id: "rec-1",
    clientName: "Synthetic",
    status: "Submitted",
    apexAccountId: "APEXACCTZHLK",
    statementAccountNumber: "STMT00000061",
    dtccNumber: "****",
    assetMap: {},
  });
  if (!mapped) throw new Error("row did not map");
  return mapped;
}

const STATUS = {
  acatTransferId: "ACT-1",
  controlNumber: null,
  direction: "IN",
  type: "FULL",
  accountType: "IRA",
  status: "Submitted",
  transferringContra: "Schwab",
  statementAmount: null,
  methodRequested: null,
  feeCharged: null,
  feeAmount: null,
  acatDate: null,
  assets: [{ symbol: "AAPL", description: "Apple", cusip: "*****4303", expectedQty: 1, actualQty: 1, mapStatus: "Mapped", issue: null, amount: null, assetClass: null }],
} satisfies Omit<AcatStatus, "apexAccountId" | "statementAccountNumber" | "dtccNumber">;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ACAT_FIXTURE", "");
});

describe("operations account numbers", () => {
  it("reads full Apex and statement numbers from the operations routes and leaves DTCC and CUSIP as returned", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      data: {
        acats: [{ id: "rec-1", status: "Submitted", apexAccountId: "APEXACCTZHLK", statementAccountNumber: "STMT00000061", dtccNumber: "****", assetMap: {} }],
        ...STATUS,
        apexAccountId: "APEXACCTZHLK",
        statementAccountNumber: "STMT00000061",
        dtccNumber: "****",
      },
    });

    const book = await fetchAcatOpsBook();
    expect(book[0].apexAccountId).toBe("APEXACCTZHLK");
    expect(book[0].statementAccountNumber).toBe("STMT00000061");
    expect(book[0].dtccNumber).toBe("****");
    expect(requestMock.mock.calls[0][0].url).toBe(`${BASE}/api/machine/acats/ops-book`);

    requestMock.mockClear();
    const list = await fetchAcatOpsList();
    expect(list[0].apexAccountId).toBe("APEXACCTZHLK");
    expect(list[0].dtccNumber).toBe("****");
    expect(requestMock.mock.calls[0][0].url).toBe(`${BASE}/api/machine/acats/ops-list`);

    requestMock.mockClear();
    requestMock.mockResolvedValue({
      status: 200,
      data: { ...STATUS, apexAccountId: "APEXACCTZHLK", statementAccountNumber: "STMT00000061", dtccNumber: "****" },
    });
    const detail = await getAcatOpsStatusByRecordId("rec-1");
    expect(detail?.apexAccountId).toBe("APEXACCTZHLK");
    expect(detail?.statementAccountNumber).toBe("STMT00000061");
    expect(detail?.dtccNumber).toBe("****");
    expect(detail?.assets[0].cusip).toBe("*****4303");
    expect(requestMock.mock.calls[0][0].url).toBe(`${BASE}/api/machine/acats/ops-record/rec-1`);
  });

  it("falls back to the masked routes when the operations routes reject the caller", async () => {
    requestMock.mockImplementation(async (opts: { url: string }) => {
      if (opts.url.includes("/ops-")) return { status: 401, data: { error: "unauthorized" } };
      if (opts.url.includes("/by-record/")) {
        return { status: 200, data: { ...STATUS, apexAccountId: "********ZHLK", statementAccountNumber: "********0061", dtccNumber: "****" } };
      }
      return {
        status: 200,
        data: { acats: [{ id: "rec-1", status: "Submitted", apexAccountId: "********ZHLK", statementAccountNumber: "********0061", dtccNumber: "****", assetMap: {} }] },
      };
    });

    const book = await fetchAcatOpsBook();
    expect(book[0].apexAccountId).toBe("********ZHLK");
    const urls = requestMock.mock.calls.map((call) => (call[0] as { url: string }).url);
    expect(urls[0]).toBe(`${BASE}/api/machine/acats/ops-book`);
    expect(urls[1]).toBe(`${BASE}/api/machine/acats?book=full`);

    requestMock.mockClear();
    const detail = await getAcatOpsStatusByRecordId("rec-1");
    expect(detail?.apexAccountId).toBe("********ZHLK");
    expect(detail?.statementAccountNumber).toBe("********0061");
    const detailUrls = requestMock.mock.calls.map((call) => (call[0] as { url: string }).url);
    expect(detailUrls[0]).toBe(`${BASE}/api/machine/acats/ops-record/rec-1`);
    expect(detailUrls[1]).toBe(`${BASE}/api/machine/acats/by-record/rec-1`);
  });

  it("keeps advisor reads on the masked routes", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      data: { acats: [], ...STATUS, apexAccountId: "********ZHLK", statementAccountNumber: "****9384", dtccNumber: "****" },
    });
    await fetchAcatList();
    expect(requestMock.mock.calls[0][0].url).toBe(`${BASE}/api/machine/acats`);
    await getAcatStatus("ACT-1");
    expect(requestMock.mock.calls[1][0].url).toBe(`${BASE}/api/machine/acats/ACT-1`);
    await getAcatStatusByRecordId("rec-1");
    expect(requestMock.mock.calls[2][0].url).toBe(`${BASE}/api/machine/acats/by-record/rec-1`);
    expect(requestMock.mock.calls.map((call) => (call[0] as { url: string }).url).join(" ")).not.toContain("/ops-");
  });

  it("shows full numbers on the operations book and status card, and keeps the fee account masked", () => {
    const row = bookRow();
    const html = renderToStaticMarkup(createElement(AcatBookView, {
      rows: [row],
      linkedTransferIds: {},
      linkedByRecordId: {},
      userName: null,
      prefsScope: "synthetic",
    }));
    expect(html).toContain("APEXACCTZHLK · STMT00000061");

    const full = renderToStaticMarkup(createElement(AcatStatusCard, {
      status: { ...STATUS, apexAccountId: "APEXACCTZHLK", statementAccountNumber: "STMT00000061", dtccNumber: "****" },
    }));
    expect(full).toContain("APEXACCTZHLK");
    expect(full).toContain("STMT00000061");
    expect(full).toContain("****");

    const masked = renderToStaticMarkup(createElement(AcatStatusCard, {
      status: { ...STATUS, apexAccountId: "********ZHLK", statementAccountNumber: "********0061", dtccNumber: "****" },
    }));
    expect(masked).toContain("********ZHLK");
    expect(masked).not.toContain("APEXACCTZHLK");

    expect(maskBookAccountForFee("APEXACCTZHLK")).toBe("********ZHLK");
    expect(maskBookAccountForFee("********ZHLK")).toBe("********ZHLK");
    expect(maskBookAccountForFee("1234")).toBe("****");
  });
});
