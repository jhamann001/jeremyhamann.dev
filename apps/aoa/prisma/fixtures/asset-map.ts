/**
 * Stable, wholly synthetic asset-map fixture for local and isolated-dev
 * workflow rehearsal. It deliberately contains both ACAT-eligible and excluded
 * positions so Operations can exercise the partial-ACAT decision handoff.
 */
export const DEV_ASSET_MAP_FIXTURE = {
  household: {
    id: "DEMO-AM-HH-0001",
    sourceFolderId: "DEMO-ASSET-MAP-FOLDER-0001",
    clientName: "Dev Transfer Test Household",
    runNumber: 1,
    processedAt: "2026-09-09T12:00:00.000Z",
    totalValue: 180_000,
  },
  account: {
    id: "DEMO-AM-ACCT-0001",
    custodian: "Fidelity",
    accountType: "Traditional IRA",
    accountNumber: "00007788",
    accountHolder: "Adah Example",
    statementDate: "2026-08-31",
    cashBalance: 5_000,
    totalValue: 180_000,
  },
  positions: [
    {
      id: "DEMO-AM-POS-0001",
      symbol: "VTI",
      description: "Synthetic total-market ETF",
      quantity: 500,
      marketValue: 125_000,
      costBasis: 92_000,
      effectiveStatus: "ACAT",
      transferring: true,
    },
    {
      id: "DEMO-AM-POS-0002",
      symbol: "BND",
      description: "Synthetic bond-market ETF",
      quantity: 400,
      marketValue: 40_000,
      costBasis: 38_500,
      effectiveStatus: "ACAT",
      transferring: true,
    },
    {
      id: "DEMO-AM-POS-0003",
      symbol: "DEVNX",
      description: "Synthetic legacy mutual fund (non-transferable)",
      quantity: 150,
      marketValue: 15_000,
      costBasis: 11_000,
      effectiveStatus: "UNSUPPORTED",
      transferring: false,
    },
  ],
} as const;
