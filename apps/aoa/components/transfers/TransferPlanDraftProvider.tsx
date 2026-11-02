"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { approveFundingPlan } from "@/app/(authenticated)/asset-transfer/actions";
import type {
  FundingPlanDraftInput,
  FundingPlanApprovalMode,
  PartialPositionDraft,
} from "@/lib/data/transfer-plan-approval";
import type {
  FundingType,
  TransferDecisionChoice,
} from "@/lib/data/transfer-types";

type DraftError = { field: string; message: string };

type TransferPlanDraftContextValue = {
  fundingType: FundingType | null;
  setFundingType: (value: FundingType | null) => void;
  basisDecision: (
    decisionId: string,
    fallback: TransferDecisionChoice,
  ) => TransferDecisionChoice;
  setBasisDecision: (
    decisionId: string,
    value: TransferDecisionChoice,
  ) => void;
  partialPosition: (symbol: string, fallback: boolean) => boolean;
  setPartialPosition: (symbol: string, value: boolean) => void;
  canEdit: boolean;
  canApprove: boolean;
  approvalMode: FundingPlanApprovalMode;
  dirty: boolean;
  pending: boolean;
  planComplete: boolean;
  approvedVersion: number;
  approvedAt: string | null;
  approvedBy: string | null;
  errors: DraftError[];
  approve: (note: string) => void;
};

const TransferPlanDraftContext =
  createContext<TransferPlanDraftContextValue | null>(null);

type InitialBasisDecision = {
  decisionId: string;
  decision: TransferDecisionChoice;
};

function recordFromBasis(rows: InitialBasisDecision[]) {
  return Object.fromEntries(rows.map((row) => [row.decisionId, row.decision]));
}

function recordFromPositions(rows: PartialPositionDraft[]) {
  return Object.fromEntries(
    rows.map((row) => [row.symbol, row.isTransferring]),
  );
}

function fingerprint(
  fundingType: FundingType | null,
  basis: Record<string, TransferDecisionChoice>,
  positions: Record<string, boolean>,
) {
  return JSON.stringify({
    fundingType,
    basis: Object.entries(basis).sort(([a], [b]) => a.localeCompare(b)),
    positions: Object.entries(positions).sort(([a], [b]) => a.localeCompare(b)),
  });
}

export function TransferPlanDraftProvider({
  transferId,
  initialFundingType,
  initialBasisDecisions,
  initialPartialPositions,
  canEdit,
  canApprove = canEdit,
  approvalMode = "PREPARATION",
  planComplete: initialPlanComplete,
  approvedVersion: initialApprovedVersion,
  approvedAt: initialApprovedAt,
  approvedBy: initialApprovedBy,
  children,
}: {
  transferId: string;
  initialFundingType: FundingType | null;
  initialBasisDecisions: InitialBasisDecision[];
  initialPartialPositions: PartialPositionDraft[];
  canEdit: boolean;
  canApprove?: boolean;
  approvalMode?: FundingPlanApprovalMode;
  planComplete: boolean;
  approvedVersion: number;
  approvedAt: string | null;
  approvedBy: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const initialBasis = useMemo(
    () => recordFromBasis(initialBasisDecisions),
    [initialBasisDecisions],
  );
  const initialPositions = useMemo(
    () => recordFromPositions(initialPartialPositions),
    [initialPartialPositions],
  );
  const [fundingType, setFundingTypeState] = useState(initialFundingType);
  const [basis, setBasis] = useState(initialBasis);
  const [positions, setPositions] = useState(initialPositions);
  const [baseline, setBaseline] = useState(() =>
    fingerprint(initialFundingType, initialBasis, initialPositions),
  );
  const [planComplete, setPlanComplete] = useState(initialPlanComplete);
  const [approvedVersion, setApprovedVersion] = useState(initialApprovedVersion);
  const [approvedAt, setApprovedAt] = useState(initialApprovedAt);
  const [approvedBy, setApprovedBy] = useState(initialApprovedBy);
  const [errors, setErrors] = useState<DraftError[]>([]);
  const [pending, startTransition] = useTransition();

  const setFundingType = useCallback((value: FundingType | null) => {
    setFundingTypeState(value);
    setErrors([]);
  }, []);
  const setBasisDecision = useCallback(
    (decisionId: string, value: TransferDecisionChoice) => {
      setBasis((current) => ({ ...current, [decisionId]: value }));
      setErrors([]);
    },
    [],
  );
  const setPartialPosition = useCallback((symbol: string, value: boolean) => {
    setPositions((current) => ({ ...current, [symbol]: value }));
    setErrors([]);
  }, []);

  const currentFingerprint = fingerprint(fundingType, basis, positions);
  const dirty = currentFingerprint !== baseline;

  const approve = useCallback(
    (note: string) => {
      if (!canApprove || pending) return;
      const input: FundingPlanDraftInput = {
        approvalMode,
        baseVersion: approvedVersion,
        fundingType,
        basisDecisions: Object.entries(basis).map(([decisionId, decision]) => ({
          decisionId,
          decision,
        })),
        partialPositions: Object.entries(positions).map(
          ([symbol, isTransferring]) => ({ symbol, isTransferring }),
        ),
        note,
      };
      startTransition(async () => {
        const result = await approveFundingPlan(transferId, input);
        if (!result.ok) {
          setErrors(result.errors);
          return;
        }
        setErrors([]);
        setPlanComplete(true);
        setApprovedVersion(result.version);
        setApprovedAt(result.approvedAt);
        setApprovedBy(result.approvedBy);
        setBaseline(currentFingerprint);
        router.refresh();
      });
    }, [
      approvalMode,
      canApprove,
      pending,
      approvedVersion,
      basis,
      currentFingerprint,
      fundingType,
      positions,
      router,
      transferId,
    ],
  );

  const value = useMemo<TransferPlanDraftContextValue>(
    () => ({
      fundingType,
      setFundingType,
      basisDecision: (decisionId, fallback) => basis[decisionId] ?? fallback,
      setBasisDecision,
      partialPosition: (symbol, fallback) => positions[symbol] ?? fallback,
      setPartialPosition,
      canEdit,
      canApprove,
      approvalMode,
      dirty,
      pending,
      planComplete,
      approvedVersion,
      approvedAt,
      approvedBy,
      errors,
      approve,
    }),
    [
      approve,
      approvedAt,
      approvedBy,
      approvedVersion,
      basis,
      canEdit,
      canApprove,
      approvalMode,
      dirty,
      errors,
      fundingType,
      pending,
      planComplete,
      positions,
      setBasisDecision,
      setFundingType,
      setPartialPosition,
    ],
  );

  return (
    <TransferPlanDraftContext.Provider value={value}>
      {children}
    </TransferPlanDraftContext.Provider>
  );
}

export function useTransferPlanDraft(): TransferPlanDraftContextValue {
  const value = useContext(TransferPlanDraftContext);
  if (!value) {
    throw new Error("Transfer plan controls require TransferPlanDraftProvider.");
  }
  return value;
}

export function useOptionalTransferPlanDraft(): TransferPlanDraftContextValue | null {
  return useContext(TransferPlanDraftContext);
}
