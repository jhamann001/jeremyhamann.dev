// Synthetic inputs for the household-resolution parity fixture (ticket). No real names or data.
const U = (n) => `01PARITY${String(n).padStart(18, "0")}`;
export const CLIENTS = [
  { id: "C-1", name: "Alder Family", accounts: [
    { id: U(1), clientId: "C-1", accountNumber: "VOV4750", accountType: "Taxable", balance: 850000.25, holdings: { cash: 850000.25, fixed: 0, equity: 0 } },
    { id: U(2), clientId: "C-1", accountNumber: "ZYP1058", accountType: "Roth IRA", balance: 120000, holdings: { cash: 120000, fixed: 0, equity: 0 } },
  ] },
  { id: "C-2", name: "Birch Trust", accounts: [
    { id: U(3), clientId: "C-2", accountNumber: "JGV9114", accountType: "Joint", balance: 50000, holdings: { cash: 50000, fixed: 0, equity: 0 } },
  ] },
  { id: "C-3", name: "Cedar Holdings", accounts: [
    { id: U(4), clientId: "C-3", accountNumber: "HNO0026", accountType: "Traditional IRA", balance: 0, holdings: { cash: 0, fixed: 0, equity: 0 } },
  ] },
];
export const ENTRIES = [
  { accountNumber: U(1), householdName: "Alder Household", accountTitle: "Alder - Brokerage", householdId: 9001 },
  { accountNumber: U(2), householdName: "Alder Household", accountTitle: "Alder - Roth", householdId: 9001 },
  { accountNumber: U(3), householdName: "Alder Household", accountTitle: "Birch - Joint", householdId: 9001 },
  { accountNumber: U(5), householdName: "Alder Household", accountTitle: "Orphan - Brokerage", householdId: 9001 },
  { accountNumber: U(4), householdName: "Cedar Household", accountTitle: "Cedar - IRA", householdId: 9002 },
  { accountNumber: U(6), householdName: "No Id Household", accountTitle: "No Id - Brokerage" },
];
export const CASES = {
  oneClient: { clientIds: ["C-1"], accountIds: [] },
  twoClients: { clientIds: ["C-1", "C-3"], accountIds: [] },
  explicitAccounts: { clientIds: ["C-1"], accountIds: [U(1)] },
  unknownClient: { clientIds: ["C-9"], accountIds: [] },
  unmappedAccount: { clientIds: [], accountIds: [U(6), U(7)] },
  empty: { clientIds: [], accountIds: [] },
};
export function householdConfig() {
  return {
    byAccountNumber: new Map(ENTRIES.map((e) => [e.accountNumber, e])),
    householdNames: new Set(ENTRIES.map((e) => e.householdName)),
    entries: ENTRIES,
  };
}
