"use client";

import { Card, CardBody, CardHeader, Pill } from "@/components/ui";
import type { PartialAcatPosition } from "@/lib/data/transfer-asset-map";
import type { TransferDecisionRow } from "@/lib/data/transfer-types";
import { BasisDecisionTable } from "./BasisDecisionTable";
import { PartialAcatPositionsTable } from "./PartialAcatPositionsTable";
import { useTransferPlanDraft } from "./TransferPlanDraftProvider";
import styles from "./TransferPlanPositionsCard.module.css";

export function TransferPlanPositionsCard({
  positions,
  decisions,
}: {
  positions: PartialAcatPosition[] | null;
  decisions: TransferDecisionRow[];
}) {
  const draft = useTransferPlanDraft();
  if (draft.fundingType !== "ACAT_PARTIAL") return null;

  return (
    <Card>
      <CardHeader className={styles.header}>
        <span>What to transfer — basis-aware decision</span>
        <Pill tone="gold">ops instructs · not advisor discretion</Pill>
      </CardHeader>
      <CardBody>
        {positions ? (
          <PartialAcatPositionsTable positions={positions} />
        ) : (
          <BasisDecisionTable decisions={decisions} />
        )}
      </CardBody>
    </Card>
  );
}
