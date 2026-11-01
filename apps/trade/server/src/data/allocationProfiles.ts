import type { AccountType, AllocationModel, Residence } from '@trade-request/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FundPosition {
  symbol: string;
  weight: number; // portfolio-level weight as a decimal (0-1)
  category: 'cash' | 'fixed' | 'equity';
}

export interface RiskProfile {
  risk: number;
  equity: number; // percentage 0-100
  fixed: number;
  cash: number;
  positions: FundPosition[];
}

export type ModelKey = 'taxableNational' | 'nationalTaxEfficient' | 'newYork' | 'california';

// ─── Model selection ─────────────────────────────────────────────────────────

const MODEL_DISPLAY_NAME: Record<ModelKey, AllocationModel> = {
  taxableNational: 'Taxable National',
  nationalTaxEfficient: 'National Tax Efficient',
  newYork: 'New York',
  california: 'California',
};

export function selectModel(accountType: AccountType, residence: Residence): ModelKey {
  if (accountType === 'Traditional IRA' || accountType === 'Roth IRA') {
    return 'taxableNational';
  }
  // Taxable and Joint both use residence-based model
  if (residence === 'NY') return 'newYork';
  if (residence === 'CA') return 'california';
  return 'nationalTaxEfficient';
}

export function getModelDisplayName(key: ModelKey): AllocationModel {
  return MODEL_DISPLAY_NAME[key];
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function p(symbol: string, weight: number, category: FundPosition['category']): FundPosition {
  return { symbol, weight: weight / 100, category };
}

// ─── Taxable National (for Traditional IRA & Roth IRA) ───
// Invented weights for the demo: cash SWVXX | fixed income VGSH, VCSH, AGG, SCHR

const taxableNational: RiskProfile[] = [
  { risk: 1, equity: 0, fixed: 0, cash: 100, positions: [p('SWVXX', 100, 'cash')] },
  { risk: 2, equity: 4, fixed: 72, cash: 24, positions: [p('Stock', 4, 'equity'), p('SWVXX', 24, 'cash'), p('VGSH', 31.5, 'fixed'), p('VCSH', 21.5, 'fixed'), p('AGG', 11.4, 'fixed'), p('SCHR', 7.6, 'fixed')] },
  { risk: 3, equity: 8, fixed: 69, cash: 23, positions: [p('Stock', 8, 'equity'), p('SWVXX', 23, 'cash'), p('VGSH', 29.3, 'fixed'), p('VCSH', 20.4, 'fixed'), p('AGG', 11.5, 'fixed'), p('SCHR', 7.8, 'fixed')] },
  { risk: 4, equity: 13, fixed: 66, cash: 21, positions: [p('Stock', 13, 'equity'), p('SWVXX', 21, 'cash'), p('VGSH', 27.2, 'fixed'), p('VCSH', 19.4, 'fixed'), p('AGG', 11.5, 'fixed'), p('SCHR', 7.9, 'fixed')] },
  { risk: 5, equity: 17, fixed: 63, cash: 20, positions: [p('Stock', 17, 'equity'), p('SWVXX', 20, 'cash'), p('VGSH', 25.2, 'fixed'), p('VCSH', 18.4, 'fixed'), p('AGG', 11.5, 'fixed'), p('SCHR', 7.9, 'fixed')] },
  { risk: 6, equity: 21, fixed: 60, cash: 19, positions: [p('Stock', 21, 'equity'), p('SWVXX', 19, 'cash'), p('VGSH', 23.3, 'fixed'), p('VCSH', 17.4, 'fixed'), p('AGG', 11.5, 'fixed'), p('SCHR', 7.8, 'fixed')] },
  { risk: 7, equity: 25, fixed: 57, cash: 18, positions: [p('Stock', 25, 'equity'), p('SWVXX', 18, 'cash'), p('VGSH', 21.4, 'fixed'), p('VCSH', 16.4, 'fixed'), p('AGG', 11.4, 'fixed'), p('SCHR', 7.8, 'fixed')] },
  { risk: 8, equity: 29, fixed: 55, cash: 16, positions: [p('Stock', 29, 'equity'), p('SWVXX', 16, 'cash'), p('VGSH', 19.9, 'fixed'), p('VCSH', 15.7, 'fixed'), p('AGG', 11.5, 'fixed'), p('SCHR', 7.9, 'fixed')] },
  { risk: 9, equity: 33, fixed: 52, cash: 15, positions: [p('Stock', 33, 'equity'), p('SWVXX', 15, 'cash'), p('VGSH', 18.2, 'fixed'), p('VCSH', 14.7, 'fixed'), p('AGG', 11.3, 'fixed'), p('SCHR', 7.8, 'fixed')] },
  { risk: 10, equity: 38, fixed: 48, cash: 14, positions: [p('Stock', 38, 'equity'), p('SWVXX', 14, 'cash'), p('VGSH', 16.2, 'fixed'), p('VCSH', 13.5, 'fixed'), p('AGG', 10.8, 'fixed'), p('SCHR', 7.5, 'fixed')] },
  { risk: 11, equity: 42, fixed: 45, cash: 13, positions: [p('Stock', 42, 'equity'), p('SWVXX', 13, 'cash'), p('VGSH', 14.6, 'fixed'), p('VCSH', 12.6, 'fixed'), p('AGG', 10.5, 'fixed'), p('SCHR', 7.3, 'fixed')] },
  { risk: 12, equity: 46, fixed: 43, cash: 11, positions: [p('Stock', 46, 'equity'), p('SWVXX', 11, 'cash'), p('VGSH', 13.4, 'fixed'), p('VCSH', 11.9, 'fixed'), p('AGG', 10.4, 'fixed'), p('SCHR', 7.3, 'fixed')] },
  { risk: 13, equity: 50, fixed: 40, cash: 10, positions: [p('Stock', 50, 'equity'), p('SWVXX', 10, 'cash'), p('VGSH', 12, 'fixed'), p('VCSH', 11, 'fixed'), p('AGG', 10, 'fixed'), p('SCHR', 7, 'fixed')] },
  { risk: 14, equity: 54, fixed: 37, cash: 9, positions: [p('Stock', 54, 'equity'), p('SWVXX', 9, 'cash'), p('VGSH', 10.6, 'fixed'), p('VCSH', 10.1, 'fixed'), p('AGG', 9.6, 'fixed'), p('SCHR', 6.7, 'fixed')] },
  { risk: 15, equity: 58, fixed: 35, cash: 7, positions: [p('Stock', 58, 'equity'), p('SWVXX', 7, 'cash'), p('VGSH', 9.6, 'fixed'), p('VCSH', 9.5, 'fixed'), p('AGG', 9.3, 'fixed'), p('SCHR', 6.6, 'fixed')] },
  { risk: 16, equity: 63, fixed: 31, cash: 6, positions: [p('Stock', 63, 'equity'), p('SWVXX', 6, 'cash'), p('VGSH', 8.1, 'fixed'), p('VCSH', 8.3, 'fixed'), p('AGG', 8.5, 'fixed'), p('SCHR', 6.1, 'fixed')] },
  { risk: 17, equity: 67, fixed: 28, cash: 5, positions: [p('Stock', 67, 'equity'), p('SWVXX', 5, 'cash'), p('VGSH', 7, 'fixed'), p('VCSH', 7.5, 'fixed'), p('AGG', 7.9, 'fixed'), p('SCHR', 5.6, 'fixed')] },
  { risk: 18, equity: 71, fixed: 25, cash: 4, positions: [p('Stock', 71, 'equity'), p('SWVXX', 4, 'cash'), p('VGSH', 5.9, 'fixed'), p('VCSH', 6.6, 'fixed'), p('AGG', 7.3, 'fixed'), p('SCHR', 5.2, 'fixed')] },
  { risk: 19, equity: 75, fixed: 23, cash: 2, positions: [p('Stock', 75, 'equity'), p('SWVXX', 2, 'cash'), p('VGSH', 5.2, 'fixed'), p('VCSH', 6, 'fixed'), p('AGG', 6.9, 'fixed'), p('SCHR', 4.9, 'fixed')] },
  { risk: 20, equity: 79, fixed: 20, cash: 1, positions: [p('Stock', 79, 'equity'), p('SWVXX', 1, 'cash'), p('VGSH', 4.3, 'fixed'), p('VCSH', 5.2, 'fixed'), p('AGG', 6.2, 'fixed'), p('SCHR', 4.3, 'fixed')] },
  { risk: 21, equity: 83, fixed: 17, cash: 0, positions: [p('Stock', 83, 'equity'), p('VGSH', 3.4, 'fixed'), p('VCSH', 4.4, 'fixed'), p('AGG', 5.4, 'fixed'), p('SCHR', 3.8, 'fixed')] },
  { risk: 22, equity: 88, fixed: 12, cash: 0, positions: [p('Stock', 88, 'equity'), p('VGSH', 2.2, 'fixed'), p('VCSH', 3.1, 'fixed'), p('AGG', 3.9, 'fixed'), p('SCHR', 2.8, 'fixed')] },
  { risk: 23, equity: 92, fixed: 8, cash: 0, positions: [p('Stock', 92, 'equity'), p('VGSH', 1.4, 'fixed'), p('VCSH', 2, 'fixed'), p('AGG', 2.7, 'fixed'), p('SCHR', 1.9, 'fixed')] },
  { risk: 24, equity: 96, fixed: 4, cash: 0, positions: [p('Stock', 96, 'equity'), p('VGSH', 0.6, 'fixed'), p('VCSH', 1, 'fixed'), p('AGG', 1.4, 'fixed'), p('SCHR', 1, 'fixed')] },
  { risk: 25, equity: 100, fixed: 0, cash: 0, positions: [p('Stock', 100, 'equity')] },
];

// ─── National Tax Efficient (taxable accounts, most states) ───
// Invented weights for the demo: cash VMSXX | fixed income SUB, VTEB, MUB

const nationalTaxEfficient: RiskProfile[] = [
  { risk: 1, equity: 0, fixed: 0, cash: 100, positions: [p('VMSXX', 100, 'cash')] },
  { risk: 2, equity: 4, fixed: 72, cash: 24, positions: [p('Stock', 4, 'equity'), p('VMSXX', 24, 'cash'), p('SUB', 35.1, 'fixed'), p('VTEB', 22, 'fixed'), p('MUB', 14.9, 'fixed')] },
  { risk: 3, equity: 8, fixed: 69, cash: 23, positions: [p('Stock', 8, 'equity'), p('VMSXX', 23, 'cash'), p('SUB', 32.8, 'fixed'), p('VTEB', 21.6, 'fixed'), p('MUB', 14.6, 'fixed')] },
  { risk: 4, equity: 13, fixed: 66, cash: 21, positions: [p('Stock', 13, 'equity'), p('VMSXX', 21, 'cash'), p('SUB', 30.5, 'fixed'), p('VTEB', 21, 'fixed'), p('MUB', 14.5, 'fixed')] },
  { risk: 5, equity: 17, fixed: 63, cash: 20, positions: [p('Stock', 17, 'equity'), p('VMSXX', 20, 'cash'), p('SUB', 28.4, 'fixed'), p('VTEB', 20.5, 'fixed'), p('MUB', 14.1, 'fixed')] },
  { risk: 6, equity: 21, fixed: 60, cash: 19, positions: [p('Stock', 21, 'equity'), p('VMSXX', 19, 'cash'), p('SUB', 26.3, 'fixed'), p('VTEB', 19.9, 'fixed'), p('MUB', 13.8, 'fixed')] },
  { risk: 7, equity: 25, fixed: 57, cash: 18, positions: [p('Stock', 25, 'equity'), p('VMSXX', 18, 'cash'), p('SUB', 24.2, 'fixed'), p('VTEB', 19.2, 'fixed'), p('MUB', 13.6, 'fixed')] },
  { risk: 8, equity: 29, fixed: 55, cash: 16, positions: [p('Stock', 29, 'equity'), p('VMSXX', 16, 'cash'), p('SUB', 22.7, 'fixed'), p('VTEB', 18.9, 'fixed'), p('MUB', 13.4, 'fixed')] },
  { risk: 9, equity: 33, fixed: 52, cash: 15, positions: [p('Stock', 33, 'equity'), p('VMSXX', 15, 'cash'), p('SUB', 20.8, 'fixed'), p('VTEB', 18.2, 'fixed'), p('MUB', 13, 'fixed')] },
  { risk: 10, equity: 38, fixed: 48, cash: 14, positions: [p('Stock', 38, 'equity'), p('VMSXX', 14, 'cash'), p('SUB', 18.6, 'fixed'), p('VTEB', 17.1, 'fixed'), p('MUB', 12.3, 'fixed')] },
  { risk: 11, equity: 42, fixed: 45, cash: 13, positions: [p('Stock', 42, 'equity'), p('VMSXX', 13, 'cash'), p('SUB', 16.9, 'fixed'), p('VTEB', 16.3, 'fixed'), p('MUB', 11.8, 'fixed')] },
  { risk: 12, equity: 46, fixed: 43, cash: 11, positions: [p('Stock', 46, 'equity'), p('VMSXX', 11, 'cash'), p('SUB', 15.6, 'fixed'), p('VTEB', 15.9, 'fixed'), p('MUB', 11.5, 'fixed')] },
  { risk: 13, equity: 50, fixed: 40, cash: 10, positions: [p('Stock', 50, 'equity'), p('VMSXX', 10, 'cash'), p('SUB', 14, 'fixed'), p('VTEB', 15, 'fixed'), p('MUB', 11, 'fixed')] },
  { risk: 14, equity: 54, fixed: 37, cash: 9, positions: [p('Stock', 54, 'equity'), p('VMSXX', 9, 'cash'), p('SUB', 12.5, 'fixed'), p('VTEB', 14.1, 'fixed'), p('MUB', 10.4, 'fixed')] },
  { risk: 15, equity: 58, fixed: 35, cash: 7, positions: [p('Stock', 58, 'equity'), p('VMSXX', 7, 'cash'), p('SUB', 11.4, 'fixed'), p('VTEB', 13.6, 'fixed'), p('MUB', 10, 'fixed')] },
  { risk: 16, equity: 63, fixed: 31, cash: 6, positions: [p('Stock', 63, 'equity'), p('VMSXX', 6, 'cash'), p('SUB', 9.7, 'fixed'), p('VTEB', 12.2, 'fixed'), p('MUB', 9.1, 'fixed')] },
  { risk: 17, equity: 67, fixed: 28, cash: 5, positions: [p('Stock', 67, 'equity'), p('VMSXX', 5, 'cash'), p('SUB', 8.4, 'fixed'), p('VTEB', 11.2, 'fixed'), p('MUB', 8.4, 'fixed')] },
  { risk: 18, equity: 71, fixed: 25, cash: 4, positions: [p('Stock', 71, 'equity'), p('VMSXX', 4, 'cash'), p('SUB', 7.2, 'fixed'), p('VTEB', 10.2, 'fixed'), p('MUB', 7.6, 'fixed')] },
  { risk: 19, equity: 75, fixed: 23, cash: 2, positions: [p('Stock', 75, 'equity'), p('VMSXX', 2, 'cash'), p('SUB', 6.3, 'fixed'), p('VTEB', 9.5, 'fixed'), p('MUB', 7.2, 'fixed')] },
  { risk: 20, equity: 79, fixed: 20, cash: 1, positions: [p('Stock', 79, 'equity'), p('VMSXX', 1, 'cash'), p('SUB', 5.3, 'fixed'), p('VTEB', 8.4, 'fixed'), p('MUB', 6.3, 'fixed')] },
  { risk: 21, equity: 83, fixed: 17, cash: 0, positions: [p('Stock', 83, 'equity'), p('SUB', 4.3, 'fixed'), p('VTEB', 7.2, 'fixed'), p('MUB', 5.5, 'fixed')] },
  { risk: 22, equity: 88, fixed: 12, cash: 0, positions: [p('Stock', 88, 'equity'), p('SUB', 2.8, 'fixed'), p('VTEB', 5.2, 'fixed'), p('MUB', 4, 'fixed')] },
  { risk: 23, equity: 92, fixed: 8, cash: 0, positions: [p('Stock', 92, 'equity'), p('SUB', 1.8, 'fixed'), p('VTEB', 3.5, 'fixed'), p('MUB', 2.7, 'fixed')] },
  { risk: 24, equity: 96, fixed: 4, cash: 0, positions: [p('Stock', 96, 'equity'), p('SUB', 0.9, 'fixed'), p('VTEB', 1.8, 'fixed'), p('MUB', 1.3, 'fixed')] },
  { risk: 25, equity: 100, fixed: 0, cash: 0, positions: [p('Stock', 100, 'equity')] },
];

// ─── New York (taxable accounts, NY residents) ───
// Invented weights for the demo: cash VYFXX | fixed income SUB, VNYTX, MUB

const newYork: RiskProfile[] = [
  { risk: 1, equity: 0, fixed: 0, cash: 100, positions: [p('VYFXX', 100, 'cash')] },
  { risk: 2, equity: 4, fixed: 72, cash: 24, positions: [p('Stock', 4, 'equity'), p('VYFXX', 24, 'cash'), p('SUB', 31.5, 'fixed'), p('VNYTX', 25.8, 'fixed'), p('MUB', 14.7, 'fixed')] },
  { risk: 3, equity: 8, fixed: 69, cash: 23, positions: [p('Stock', 8, 'equity'), p('VYFXX', 23, 'cash'), p('SUB', 29.3, 'fixed'), p('VNYTX', 25.3, 'fixed'), p('MUB', 14.4, 'fixed')] },
  { risk: 4, equity: 13, fixed: 66, cash: 21, positions: [p('Stock', 13, 'equity'), p('VYFXX', 21, 'cash'), p('SUB', 27.2, 'fixed'), p('VNYTX', 24.8, 'fixed'), p('MUB', 14, 'fixed')] },
  { risk: 5, equity: 17, fixed: 63, cash: 20, positions: [p('Stock', 17, 'equity'), p('VYFXX', 20, 'cash'), p('SUB', 25.2, 'fixed'), p('VNYTX', 24.2, 'fixed'), p('MUB', 13.6, 'fixed')] },
  { risk: 6, equity: 21, fixed: 60, cash: 19, positions: [p('Stock', 21, 'equity'), p('VYFXX', 19, 'cash'), p('SUB', 23.3, 'fixed'), p('VNYTX', 23.5, 'fixed'), p('MUB', 13.2, 'fixed')] },
  { risk: 7, equity: 25, fixed: 57, cash: 18, positions: [p('Stock', 25, 'equity'), p('VYFXX', 18, 'cash'), p('SUB', 21.4, 'fixed'), p('VNYTX', 22.8, 'fixed'), p('MUB', 12.8, 'fixed')] },
  { risk: 8, equity: 29, fixed: 55, cash: 16, positions: [p('Stock', 29, 'equity'), p('VYFXX', 16, 'cash'), p('SUB', 19.9, 'fixed'), p('VNYTX', 22.5, 'fixed'), p('MUB', 12.6, 'fixed')] },
  { risk: 9, equity: 33, fixed: 52, cash: 15, positions: [p('Stock', 33, 'equity'), p('VYFXX', 15, 'cash'), p('SUB', 18.2, 'fixed'), p('VNYTX', 21.7, 'fixed'), p('MUB', 12.1, 'fixed')] },
  { risk: 10, equity: 38, fixed: 48, cash: 14, positions: [p('Stock', 38, 'equity'), p('VYFXX', 14, 'cash'), p('SUB', 16.2, 'fixed'), p('VNYTX', 20.4, 'fixed'), p('MUB', 11.4, 'fixed')] },
  { risk: 11, equity: 42, fixed: 45, cash: 13, positions: [p('Stock', 42, 'equity'), p('VYFXX', 13, 'cash'), p('SUB', 14.6, 'fixed'), p('VNYTX', 19.5, 'fixed'), p('MUB', 10.9, 'fixed')] },
  { risk: 12, equity: 46, fixed: 43, cash: 11, positions: [p('Stock', 46, 'equity'), p('VYFXX', 11, 'cash'), p('SUB', 13.4, 'fixed'), p('VNYTX', 19, 'fixed'), p('MUB', 10.6, 'fixed')] },
  { risk: 13, equity: 50, fixed: 40, cash: 10, positions: [p('Stock', 50, 'equity'), p('VYFXX', 10, 'cash'), p('SUB', 12, 'fixed'), p('VNYTX', 18, 'fixed'), p('MUB', 10, 'fixed')] },
  { risk: 14, equity: 54, fixed: 37, cash: 9, positions: [p('Stock', 54, 'equity'), p('VYFXX', 9, 'cash'), p('SUB', 10.6, 'fixed'), p('VNYTX', 17, 'fixed'), p('MUB', 9.4, 'fixed')] },
  { risk: 15, equity: 58, fixed: 35, cash: 7, positions: [p('Stock', 58, 'equity'), p('VYFXX', 7, 'cash'), p('SUB', 9.6, 'fixed'), p('VNYTX', 16.3, 'fixed'), p('MUB', 9.1, 'fixed')] },
  { risk: 16, equity: 63, fixed: 31, cash: 6, positions: [p('Stock', 63, 'equity'), p('VYFXX', 6, 'cash'), p('SUB', 8.1, 'fixed'), p('VNYTX', 14.7, 'fixed'), p('MUB', 8.2, 'fixed')] },
  { risk: 17, equity: 67, fixed: 28, cash: 5, positions: [p('Stock', 67, 'equity'), p('VYFXX', 5, 'cash'), p('SUB', 7, 'fixed'), p('VNYTX', 13.5, 'fixed'), p('MUB', 7.5, 'fixed')] },
  { risk: 18, equity: 71, fixed: 25, cash: 4, positions: [p('Stock', 71, 'equity'), p('VYFXX', 4, 'cash'), p('SUB', 5.9, 'fixed'), p('VNYTX', 12.3, 'fixed'), p('MUB', 6.8, 'fixed')] },
  { risk: 19, equity: 75, fixed: 23, cash: 2, positions: [p('Stock', 75, 'equity'), p('VYFXX', 2, 'cash'), p('SUB', 5.2, 'fixed'), p('VNYTX', 11.5, 'fixed'), p('MUB', 6.3, 'fixed')] },
  { risk: 20, equity: 79, fixed: 20, cash: 1, positions: [p('Stock', 79, 'equity'), p('VYFXX', 1, 'cash'), p('SUB', 4.3, 'fixed'), p('VNYTX', 10.2, 'fixed'), p('MUB', 5.5, 'fixed')] },
  { risk: 21, equity: 83, fixed: 17, cash: 0, positions: [p('Stock', 83, 'equity'), p('SUB', 3.4, 'fixed'), p('VNYTX', 8.8, 'fixed'), p('MUB', 4.8, 'fixed')] },
  { risk: 22, equity: 88, fixed: 12, cash: 0, positions: [p('Stock', 88, 'equity'), p('SUB', 2.2, 'fixed'), p('VNYTX', 6.3, 'fixed'), p('MUB', 3.5, 'fixed')] },
  { risk: 23, equity: 92, fixed: 8, cash: 0, positions: [p('Stock', 92, 'equity'), p('SUB', 1.4, 'fixed'), p('VNYTX', 4.3, 'fixed'), p('MUB', 2.3, 'fixed')] },
  { risk: 24, equity: 96, fixed: 4, cash: 0, positions: [p('Stock', 96, 'equity'), p('SUB', 0.6, 'fixed'), p('VNYTX', 2.2, 'fixed'), p('MUB', 1.2, 'fixed')] },
  { risk: 25, equity: 100, fixed: 0, cash: 0, positions: [p('Stock', 100, 'equity')] },
];

// ─── California (taxable accounts, CA residents) ───
// Invented weights for the demo: cash VCTXX | fixed income SUB, VCAIX, MUB

const california: RiskProfile[] = [
  { risk: 1, equity: 0, fixed: 0, cash: 100, positions: [p('VCTXX', 100, 'cash')] },
  { risk: 2, equity: 4, fixed: 72, cash: 24, positions: [p('Stock', 4, 'equity'), p('VCTXX', 24, 'cash'), p('SUB', 31.5, 'fixed'), p('VCAIX', 25.8, 'fixed'), p('MUB', 14.7, 'fixed')] },
  { risk: 3, equity: 8, fixed: 69, cash: 23, positions: [p('Stock', 8, 'equity'), p('VCTXX', 23, 'cash'), p('SUB', 29.3, 'fixed'), p('VCAIX', 25.3, 'fixed'), p('MUB', 14.4, 'fixed')] },
  { risk: 4, equity: 13, fixed: 66, cash: 21, positions: [p('Stock', 13, 'equity'), p('VCTXX', 21, 'cash'), p('SUB', 27.2, 'fixed'), p('VCAIX', 24.8, 'fixed'), p('MUB', 14, 'fixed')] },
  { risk: 5, equity: 17, fixed: 63, cash: 20, positions: [p('Stock', 17, 'equity'), p('VCTXX', 20, 'cash'), p('SUB', 25.2, 'fixed'), p('VCAIX', 24.2, 'fixed'), p('MUB', 13.6, 'fixed')] },
  { risk: 6, equity: 21, fixed: 60, cash: 19, positions: [p('Stock', 21, 'equity'), p('VCTXX', 19, 'cash'), p('SUB', 23.3, 'fixed'), p('VCAIX', 23.5, 'fixed'), p('MUB', 13.2, 'fixed')] },
  { risk: 7, equity: 25, fixed: 57, cash: 18, positions: [p('Stock', 25, 'equity'), p('VCTXX', 18, 'cash'), p('SUB', 21.4, 'fixed'), p('VCAIX', 22.8, 'fixed'), p('MUB', 12.8, 'fixed')] },
  { risk: 8, equity: 29, fixed: 55, cash: 16, positions: [p('Stock', 29, 'equity'), p('VCTXX', 16, 'cash'), p('SUB', 19.9, 'fixed'), p('VCAIX', 22.5, 'fixed'), p('MUB', 12.6, 'fixed')] },
  { risk: 9, equity: 33, fixed: 52, cash: 15, positions: [p('Stock', 33, 'equity'), p('VCTXX', 15, 'cash'), p('SUB', 18.2, 'fixed'), p('VCAIX', 21.7, 'fixed'), p('MUB', 12.1, 'fixed')] },
  { risk: 10, equity: 38, fixed: 48, cash: 14, positions: [p('Stock', 38, 'equity'), p('VCTXX', 14, 'cash'), p('SUB', 16.2, 'fixed'), p('VCAIX', 20.4, 'fixed'), p('MUB', 11.4, 'fixed')] },
  { risk: 11, equity: 42, fixed: 45, cash: 13, positions: [p('Stock', 42, 'equity'), p('VCTXX', 13, 'cash'), p('SUB', 14.6, 'fixed'), p('VCAIX', 19.5, 'fixed'), p('MUB', 10.9, 'fixed')] },
  { risk: 12, equity: 46, fixed: 43, cash: 11, positions: [p('Stock', 46, 'equity'), p('VCTXX', 11, 'cash'), p('SUB', 13.4, 'fixed'), p('VCAIX', 19, 'fixed'), p('MUB', 10.6, 'fixed')] },
  { risk: 13, equity: 50, fixed: 40, cash: 10, positions: [p('Stock', 50, 'equity'), p('VCTXX', 10, 'cash'), p('SUB', 12, 'fixed'), p('VCAIX', 18, 'fixed'), p('MUB', 10, 'fixed')] },
  { risk: 14, equity: 54, fixed: 37, cash: 9, positions: [p('Stock', 54, 'equity'), p('VCTXX', 9, 'cash'), p('SUB', 10.6, 'fixed'), p('VCAIX', 17, 'fixed'), p('MUB', 9.4, 'fixed')] },
  { risk: 15, equity: 58, fixed: 35, cash: 7, positions: [p('Stock', 58, 'equity'), p('VCTXX', 7, 'cash'), p('SUB', 9.6, 'fixed'), p('VCAIX', 16.3, 'fixed'), p('MUB', 9.1, 'fixed')] },
  { risk: 16, equity: 63, fixed: 31, cash: 6, positions: [p('Stock', 63, 'equity'), p('VCTXX', 6, 'cash'), p('SUB', 8.1, 'fixed'), p('VCAIX', 14.7, 'fixed'), p('MUB', 8.2, 'fixed')] },
  { risk: 17, equity: 67, fixed: 28, cash: 5, positions: [p('Stock', 67, 'equity'), p('VCTXX', 5, 'cash'), p('SUB', 7, 'fixed'), p('VCAIX', 13.5, 'fixed'), p('MUB', 7.5, 'fixed')] },
  { risk: 18, equity: 71, fixed: 25, cash: 4, positions: [p('Stock', 71, 'equity'), p('VCTXX', 4, 'cash'), p('SUB', 5.9, 'fixed'), p('VCAIX', 12.3, 'fixed'), p('MUB', 6.8, 'fixed')] },
  { risk: 19, equity: 75, fixed: 23, cash: 2, positions: [p('Stock', 75, 'equity'), p('VCTXX', 2, 'cash'), p('SUB', 5.2, 'fixed'), p('VCAIX', 11.5, 'fixed'), p('MUB', 6.3, 'fixed')] },
  { risk: 20, equity: 79, fixed: 20, cash: 1, positions: [p('Stock', 79, 'equity'), p('VCTXX', 1, 'cash'), p('SUB', 4.3, 'fixed'), p('VCAIX', 10.2, 'fixed'), p('MUB', 5.5, 'fixed')] },
  { risk: 21, equity: 83, fixed: 17, cash: 0, positions: [p('Stock', 83, 'equity'), p('SUB', 3.4, 'fixed'), p('VCAIX', 8.8, 'fixed'), p('MUB', 4.8, 'fixed')] },
  { risk: 22, equity: 88, fixed: 12, cash: 0, positions: [p('Stock', 88, 'equity'), p('SUB', 2.2, 'fixed'), p('VCAIX', 6.3, 'fixed'), p('MUB', 3.5, 'fixed')] },
  { risk: 23, equity: 92, fixed: 8, cash: 0, positions: [p('Stock', 92, 'equity'), p('SUB', 1.4, 'fixed'), p('VCAIX', 4.3, 'fixed'), p('MUB', 2.3, 'fixed')] },
  { risk: 24, equity: 96, fixed: 4, cash: 0, positions: [p('Stock', 96, 'equity'), p('SUB', 0.6, 'fixed'), p('VCAIX', 2.2, 'fixed'), p('MUB', 1.2, 'fixed')] },
  { risk: 25, equity: 100, fixed: 0, cash: 0, positions: [p('Stock', 100, 'equity')] },
];

// ─── Model registry ──────────────────────────────────────────────────────────

const MODELS: Record<ModelKey, RiskProfile[]> = {
  taxableNational,
  nationalTaxEfficient,
  newYork,
  california,
};

export function getProfile(model: ModelKey, riskLevel: number): RiskProfile {
  if (!Number.isFinite(riskLevel)) {
    throw new Error(`Invalid risk level: ${riskLevel}`);
  }
  const idx = Math.max(0, Math.min(24, Math.round(riskLevel) - 1));
  return MODELS[model][idx];
}
