import type { DealStage } from "@/lib/data/deal-types";

/** Postgres date values arrive at UTC midnight. Preserve that calendar date;
 * projecting the value into Eastern time would move it to the previous day. */
export function expectedCloseDay(value: Date | null): string | null {
  return value == null || !Number.isFinite(value.getTime())
    ? null
    : value.toISOString().slice(0, 10);
}

/** ticket: the caller supplies one Eastern calendar-date snapshot for the
 * whole render. This predicate deliberately has no clock or ambient timezone. */
export function isExpectedCloseOverdue(
  stage: DealStage,
  closeDate: Date | null,
  todayEt: string,
): boolean {
  const closeDay = expectedCloseDay(closeDate);
  return stage !== "WON" && stage !== "LOST" && closeDay != null && closeDay < todayEt;
}
