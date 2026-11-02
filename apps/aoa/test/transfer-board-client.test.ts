import { describe, expect, it } from "vitest";
import {
  toTransferBoardClientRow,
  type TransferBoardClientRow,
} from "@/lib/data/transfer-board-client";
import type { TransferBoardRow } from "@/lib/data/transfers";

describe("toTransferBoardClientRow (server → browser boundary)", () => {
  it("physically omits the raw asset-map account number", () => {
    const rawRow = {
      id: "transfer-1",
      asset_map_account_number: "761704106",
    } as unknown as TransferBoardRow;

    const clientRow = toTransferBoardClientRow(rawRow, {
      registrationType: "Traditional IRA",
      status: "OPEN",
      apexAccountMasked: "••••4106",
    });

    expect(clientRow.id).toBe("transfer-1");
    expect(clientRow.receivingAccount?.apexAccountMasked).toBe("••••4106");
    expect(
      Object.prototype.hasOwnProperty.call(
        clientRow,
        "asset_map_account_number",
      ),
    ).toBe(false);
    expect(JSON.stringify(clientRow)).not.toContain("761704106");
  });

  it("makes raw board rows incompatible with client component props", () => {
    type RawRowIsAssignable =
      TransferBoardRow extends TransferBoardClientRow ? true : false;
    const rawRowIsAssignable: RawRowIsAssignable = false;

    expect(rawRowIsAssignable).toBe(false);
  });
});
