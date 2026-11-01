import type { AcatRecord } from "./types";
import {
  DATA_QUALITY_RULES,
  contraPerformance,
  dashboardDataQualityExceptions,
  finalizedSummary,
  flowSummary,
  monthlyTransferVolume,
  reconCoverage,
  residualBenchmarks,
  residualMonitorQueue,
  workflowTimings,
} from "./transfer-analytics";

export type DashboardReview = {
  acatRecordId: string;
  ruleKey: string;
  fingerprint: string;
  status: string;
  resolution?: string | null;
  note?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: Date | string | null;
};

export function composeDashboardContract(
  records: AcatRecord[],
  reviews: DashboardReview[],
  now = new Date(),
) {
  const reviewByKey = new Map(
    reviews.map((review) => [
      `${review.acatRecordId}|${review.ruleKey}|${review.fingerprint}`,
      review,
    ]),
  );
  const exceptions = dashboardDataQualityExceptions(records, now).map((item) => {
    const review = reviewByKey.get(
      `${item.record.id}|${item.ruleKey}|${item.fingerprint}`,
    );
    return {
      record: {
        id: item.record.id,
        clientName: item.record.clientName,
        transferringContra: item.record.transferringContra ?? null,
      },
      ruleKey: item.ruleKey,
      fingerprint: item.fingerprint,
      title: item.title,
      detail: item.detail,
      severity: item.severity,
      review: review
        ? {
            status: review.status,
            resolution: review.resolution ?? null,
            note: review.note ?? null,
            reviewedBy: review.reviewedBy ?? null,
            reviewedAt:
              review.reviewedAt instanceof Date
                ? review.reviewedAt.toISOString()
                : review.reviewedAt ?? null,
          }
        : null,
    };
  });
  const queue = residualMonitorQueue(records, now).map((item) => ({
    record: {
      id: item.record.id,
      clientName: item.record.clientName,
      transferringContra: item.record.transferringContra ?? null,
    },
    followUpDate: item.followUpDate,
    daysPastFollowUp: item.daysPastFollowUp,
  }));

  return {
    summary: finalizedSummary(records),
    workflowTimings: workflowTimings(records),
    monthlyVolume: monthlyTransferVolume(records, undefined, now),
    flow: flowSummary(records),
    topContras: {
      acat: contraPerformance(records, "ACAT").slice(0, 5),
      manual: contraPerformance(records, "MANUAL").slice(0, 5),
    },
    residuals: {
      queue,
      benchmarks: residualBenchmarks(records),
    },
    quality: {
      rules: DATA_QUALITY_RULES,
      exceptions,
    },
    reconciliation: reconCoverage(records),
  };
}
