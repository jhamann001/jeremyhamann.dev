import { normalizeContra, ALIAS } from "./contra-normalize";

export interface DtccRecordLike {
  transferringContra?: string | null;
  dtccNumber?: string | null;
}

export interface DtccCustodianLike {
  name: string;
  dtcNumber?: string | null;
}

export interface DtccSuggestion {
  status: "suggested" | "ambiguous" | "insufficient" | "none";
  dtccNumber: string | null;
  source: "custodian" | "history" | null;
  historicalSampleSize: number;
}

function contraKey(value?: string | null): string {
  const normalized = normalizeContra(value);
  return normalizeContra(ALIAS[normalized] ?? value);
}

export function normalizeDtccNumber(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return trimmed.padStart(4, "0");
}

export function suggestDtccNumber(
  records: DtccRecordLike[],
  custodians: DtccCustodianLike[],
  contra?: string | null
): DtccSuggestion {
  const key = contraKey(contra);
  if (!key) return { status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 };

  const matchingHistory = records.filter((record) => contraKey(record.transferringContra) === key && record.dtccNumber?.trim());
  const historicalValues = matchingHistory.map((record) => normalizeDtccNumber(record.dtccNumber));
  const hasInvalidHistory = historicalValues.some((value) => value == null);
  const historyCandidates = new Set(historicalValues.filter((value): value is string => value != null));

  const matchingCustodians = custodians.filter((custodian) => contraKey(custodian.name) === key && custodian.dtcNumber?.trim());
  const custodianValues = matchingCustodians.map((custodian) => normalizeDtccNumber(custodian.dtcNumber));
  const hasInvalidCustodian = custodianValues.some((value) => value == null);
  const custodianCandidates = new Set(custodianValues.filter((value): value is string => value != null));
  const candidates = new Set([...historyCandidates, ...custodianCandidates]);

  if (hasInvalidHistory || hasInvalidCustodian || candidates.size > 1) {
    return { status: "ambiguous", dtccNumber: null, source: null, historicalSampleSize: matchingHistory.length };
  }
  const [only] = [...candidates];
  if (!only) return { status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 };
  if (custodianCandidates.size === 1) {
    return { status: "suggested", dtccNumber: only, source: "custodian", historicalSampleSize: matchingHistory.length };
  }
  if (matchingHistory.length >= 2) {
    return { status: "suggested", dtccNumber: only, source: "history", historicalSampleSize: matchingHistory.length };
  }
  return { status: "insufficient", dtccNumber: null, source: null, historicalSampleSize: matchingHistory.length };
}
