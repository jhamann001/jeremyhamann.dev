import type { ClientAccounts } from "@/lib/data/types";

export type AllocationSlice = {
  label: string;
  percentage: number;
  color: string;
};

export type GrowthPoint = {
  year: number;
  value: number;
};

export type IllustrationSnapshot = {
  apexValue: number;
  externalValue: number;
  startingValue: number;
};

export function allocationTotal(slices: readonly AllocationSlice[]): number {
  return slices.reduce((sum, slice) => sum + slice.percentage, 0);
}

export function illustrationSnapshot(
  accounts: ClientAccounts,
  fallbackStartingValue: number,
): IllustrationSnapshot {
  const apexValue = accounts.apex.reduce(
    (sum, account) => sum + (account.value ?? 0),
    0,
  );
  const externalValue = accounts.plaidLinked
    ? accounts.ext.reduce((sum, account) => sum + account.balance, 0)
    : 0;
  return {
    apexValue,
    externalValue,
    startingValue: apexValue + externalValue || fallbackStartingValue,
  };
}

export function growthProjection(
  startingValue: number,
  annualReturnPercent: number,
  years: number,
): GrowthPoint[] {
  const safeStartingValue = Math.max(0, Number(startingValue) || 0);
  const safeRate = Math.max(-100, Number(annualReturnPercent) || 0) / 100;
  const safeYears = Math.max(1, Math.min(50, Math.round(Number(years) || 1)));

  return Array.from({ length: safeYears + 1 }, (_, year) => ({
    year,
    value: safeStartingValue * Math.pow(1 + safeRate, year),
  }));
}

export function projectedEndingValue(
  startingValue: number,
  annualReturnPercent: number,
  years: number,
): number {
  return growthProjection(startingValue, annualReturnPercent, years).at(-1)?.value ?? 0;
}

const RMD_FACTORS: Record<number, number> = {
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
};

export function retirementIncomeIllustration({
  iraBalance,
  age,
  qcdAmount,
  marginalRatePercent,
}: {
  iraBalance: number;
  age: number;
  qcdAmount: number;
  marginalRatePercent: number;
}) {
  const safeBalance = Math.max(0, iraBalance);
  const safeAge = Math.max(73, Math.min(92, Math.round(age)));
  const factor = RMD_FACTORS[safeAge];
  const rmd = safeBalance / factor;
  const qcd = Math.min(Math.max(0, qcdAmount), 108_000, rmd);
  const taxableRmd = Math.max(0, rmd - qcd);
  const rate = Math.max(0, marginalRatePercent) / 100;
  return {
    factor,
    rmd,
    qcd,
    taxableRmd,
    estimatedTaxFullCash: rmd * rate,
    estimatedTaxWithQcd: taxableRmd * rate,
    estimatedTaxSaved: qcd * rate,
  };
}

export type RebalanceAllocation = Record<"Equity" | "Bonds" | "Alternatives" | "Cash", number>;

export function rebalanceIllustration({
  portfolioValue,
  newCash,
  moveTowardTargetPercent,
  current,
  target,
  estimatedTaxRatePercent,
}: {
  portfolioValue: number;
  newCash: number;
  moveTowardTargetPercent: number;
  current: RebalanceAllocation;
  target: RebalanceAllocation;
  estimatedTaxRatePercent: number;
}) {
  const keys = Object.keys(current) as (keyof RebalanceAllocation)[];
  const baseValue = Math.max(0, portfolioValue);
  const cash = Math.max(0, newCash);
  const totalValue = baseValue + cash;
  const mix = Math.max(0, Math.min(100, moveTowardTargetPercent)) / 100;
  const currentDollars = Object.fromEntries(
    keys.map((key) => [key, baseValue * current[key] / 100]),
  ) as RebalanceAllocation;
  const deficits = Object.fromEntries(
    keys.map((key) => [key, Math.max(0, target[key] * totalValue / 100 - currentDollars[key])]),
  ) as RebalanceAllocation;
  const totalDeficit = keys.reduce((sum, key) => sum + deficits[key], 0);
  const afterCash = Object.fromEntries(
    keys.map((key) => [key, currentDollars[key] + (totalDeficit ? cash * deficits[key] / totalDeficit : 0)]),
  ) as RebalanceAllocation;
  let taxableSales = 0;
  const finalDollars = Object.fromEntries(keys.map((key) => {
    const targetDollars = target[key] * totalValue / 100;
    const value = afterCash[key] + (targetDollars - afterCash[key]) * mix;
    taxableSales += Math.max(0, afterCash[key] - value);
    return [key, value];
  })) as RebalanceAllocation;
  const allocation = Object.fromEntries(
    keys.map((key) => [key, totalValue ? finalDollars[key] / totalValue * 100 : 0]),
  ) as RebalanceAllocation;
  const drift = keys.reduce((sum, key) => sum + Math.abs(allocation[key] - target[key]), 0) / 2;

  return {
    allocation,
    totalValue,
    drift,
    taxableSales,
    estimatedTax: taxableSales * Math.max(0, estimatedTaxRatePercent) / 100,
  };
}
