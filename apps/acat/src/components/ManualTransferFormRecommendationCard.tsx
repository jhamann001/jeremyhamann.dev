"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import PartialTransferSelections from "./PartialTransferSelections";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
} from "lucide-react";
import {
  getApexTransferSelection,
  getAssetHandlingRule,
  type AssetInstruction,
  type ManualFormTemplateKey,
  type ManualTransferFormRecommendation,
  type SuggestedDeliveringFirm,
} from "@/lib/manual-transfer-forms";

interface ManualTransferFormRecommendationResponse
  extends ManualTransferFormRecommendation {
  apexAccountTitleSuggestion: string;
  deliveringAccountTitleSuggestion: string;
  apexAccountTitleConfirmation?: ApexAccountTitleConfirmation | null;
  partialAssetSelection?: {
    required: boolean;
    total: number;
    included: number;
    excluded: number;
    undecided: number;
  };
}

interface ApexAccountTitleConfirmation {
  title: string;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
}

const TEMPLATE_LABELS: Record<ManualFormTemplateKey, string> = {
  APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST:
    "Apex Customer Account Transfer Request",
  EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST:
    "Empower Withdrawal / Direct Rollover Transfer Request",
};

function valueOrMissing(value?: string | null): string {
  return value?.trim() || "Not documented";
}

function formatSuggestedFirm(firm: SuggestedDeliveringFirm): string[] {
  const location = [firm.city, firm.state, firm.zip].filter(Boolean).join(", ");
  return [
    firm.name,
    firm.dtcNumber ? `DTC ${firm.dtcNumber}` : "",
    firm.address ?? "",
    location,
  ].filter(Boolean);
}

function normalizeAccountTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export default function ManualTransferFormRecommendationCard({
  acatId,
}: {
  acatId: string;
}) {
  const { mutate: mutateCache } = useSWRConfig();
  const { data, error, isLoading, mutate } =
    useSWR<ManualTransferFormRecommendationResponse>(
      `/api/acats/${encodeURIComponent(acatId)}/manual-form-recommendation`
    );
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [assetInstructions, setAssetInstructions] = useState<
    Record<string, AssetInstruction>
  >({});
  const [receivingAccountNumbers, setReceivingAccountNumbers] = useState<
    Record<string, string>
  >({});
  const [verifiedReceivingAccountRules, setVerifiedReceivingAccountRules] =
    useState<Record<string, boolean>>({});
  const [apexAccountTitleOverride, setApexAccountTitleOverride] = useState<
    string | null
  >(null);
  const [apexAccountTitleVerifiedOverride, setApexAccountTitleVerifiedOverride] =
    useState<boolean | null>(null);
  const [apexTitleConfirmationOverride, setApexTitleConfirmationOverride] =
    useState<ApexAccountTitleConfirmation | null | undefined>(undefined);
  const [savingApexTitle, setSavingApexTitle] = useState(false);
  const [apexTitleSaveError, setApexTitleSaveError] = useState<string | null>(null);
  const [deliveringAccountTitleOverride, setDeliveringAccountTitleOverride] =
    useState<string | null>(null);
  const [deliveringAccountTitleVerified, setDeliveringAccountTitleVerified] =
    useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [unsavedSelections, setUnsavedSelections] = useState(false);
  const [generationSaved, setGenerationSaved] = useState(false);

  const effectiveSelectedRuleId = data?.candidates.some(
    (candidate) => candidate.id === selectedRuleId
  )
    ? selectedRuleId
    : data?.candidates.length === 1
      ? data.candidates[0].id
      : "";
  const selectedRule =
    data?.candidates.find(
      (candidate) => candidate.id === effectiveSelectedRuleId
    ) ?? null;
  const selectedHandling = selectedRule
    ? getAssetHandlingRule(selectedRule)
    : null;
  const assetInstruction = selectedRule
    ? assetInstructions[selectedRule.id] ??
      (selectedHandling?.mode === "FIXED"
        ? selectedHandling.instruction
        : selectedHandling?.defaultInstruction ?? "IN_KIND")
    : "IN_KIND";
  const receivingAccountNumber = selectedRule
    ? receivingAccountNumbers[selectedRule.id] ??
      data?.custodian?.receivingAccountNumber ??
      ""
    : "";
  const receivingAccountNumberReady =
    !selectedRule?.requiresVerifiedReceivingAccountNumber ||
    (receivingAccountNumber.trim().length > 0 &&
      verifiedReceivingAccountRules[selectedRule.id] === true);
  const apexTitleConfirmation =
    apexTitleConfirmationOverride === undefined
      ? data?.apexAccountTitleConfirmation ?? null
      : apexTitleConfirmationOverride;
  const apexAccountTitle =
    apexAccountTitleOverride ??
    apexTitleConfirmation?.title ??
    data?.apexAccountTitleSuggestion ??
    "";
  const apexAccountTitleVerified =
    apexAccountTitleVerifiedOverride ?? Boolean(apexTitleConfirmation);
  const apexAccountTitleReady =
    apexAccountTitle.trim().length > 0 && apexAccountTitleVerified;
  const inheritedAccountTitleReviewRequired =
    data?.inheritedAccountTitleReviewRequired === true;
  const deliveringAccountTitle =
    deliveringAccountTitleOverride ??
    data?.deliveringAccountTitleSuggestion ??
    "";
  const deliveringAccountTitleReady =
    !inheritedAccountTitleReviewRequired ||
    (deliveringAccountTitle.trim().length > 0 &&
      deliveringAccountTitleVerified);
  const inheritedTitleMismatch =
    inheritedAccountTitleReviewRequired &&
    deliveringAccountTitle.trim().length > 0 &&
    apexAccountTitle.trim().length > 0 &&
    normalizeAccountTitle(deliveringAccountTitle) !==
      normalizeAccountTitle(apexAccountTitle);
  const partialAssetSelection = data?.partialAssetSelection;
  const partialAssetSelectionReady =
    !partialAssetSelection?.required ||
    (partialAssetSelection.undecided === 0 &&
      partialAssetSelection.included > 0);

  const saveApexTitleConfirmation = async (confirmed: boolean) => {
    setApexAccountTitleVerifiedOverride(confirmed);
    setSavingApexTitle(true);
    setApexTitleSaveError(null);
    try {
      const response = await fetch(
        `/api/acats/${encodeURIComponent(acatId)}/manual-form-recommendation`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apexAccountTitle: apexAccountTitle.trim(),
            confirmed,
          }),
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Could not save the Apex title");
      }
      setApexTitleConfirmationOverride(
        confirmed
          ? {
              title: body.title ?? apexAccountTitle.trim(),
              confirmedAt: body.confirmedAt ?? new Date().toISOString(),
              confirmedBy: body.confirmedBy ?? null,
            }
          : null
      );
      if (confirmed) {
        setApexAccountTitleOverride(body.title ?? apexAccountTitle.trim());
      }
    } catch (saveError) {
      setApexAccountTitleVerifiedOverride(false);
      setApexTitleSaveError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save the Apex title"
      );
    } finally {
      setSavingApexTitle(false);
    }
  };

  const downloadForm = async () => {
    if (
      !selectedRule ||
      generating ||
      unsavedSelections ||
      !receivingAccountNumberReady ||
      !apexAccountTitleReady ||
      !deliveringAccountTitleReady ||
      !partialAssetSelectionReady
    )
      return;
    setGenerating(true);
    setGenerationError(null);
    setGenerationSaved(false);
    try {
      const response = await fetch(
        `/api/acats/${encodeURIComponent(acatId)}/manual-form-recommendation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ruleId: selectedRule.id,
            assetInstruction,
            apexAccountTitle: apexAccountTitle.trim(),
            apexAccountTitleVerified: true,
            ...(inheritedAccountTitleReviewRequired
              ? {
                  deliveringAccountTitle: deliveringAccountTitle.trim(),
                  deliveringAccountTitleVerified: true,
                }
              : {}),
            ...(selectedRule.requiresVerifiedReceivingAccountNumber
              ? {
                  receivingAccountNumber: receivingAccountNumber.trim(),
                  receivingAccountNumberVerified: true,
                }
              : {}),
          }),
        }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Could not generate the Apex form");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        "Apex-Customer-Account-Transfer-Request.pdf";
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setGenerationSaved(true);
      // The PDF is already safely stored and downloaded. A history refresh
      // failure must not report generation as failed and encourage duplicates.
      void mutateCache((key) => typeof key === "string" && key.startsWith(`/api/acats/${encodeURIComponent(acatId)}/documents`)).catch(() => {});
    } catch (downloadError) {
      setGenerationError(
        downloadError instanceof Error
          ? downloadError.message
          : "Could not generate the Apex form"
      );
    } finally {
      setGenerating(false);
    }
  };

  if (isLoading) {
    return (
      <section className="flex items-center gap-2 rounded-xl border border-card-border bg-[var(--bg-card)] px-6 py-4 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" />
        Loading transfer paperwork guidance…
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="rounded-xl border border-[color:var(--warning)] bg-[color:var(--warning-bg)] px-6 py-4 text-sm text-[color:var(--warning)]">
        Manual paperwork guidance is temporarily unavailable.
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-[var(--bg-card)]">
      <div className="border-b border-card-border px-6 py-4">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">
            Transfer paperwork recommendation
          </h3>
          {data.status === "ACTION_REQUIRED" && (
            <span className="rounded-full bg-[color:var(--warning-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--warning)]">
              Review needed
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          {data.custodian
            ? `Form logic is combined with the live ${data.custodian.name} Custodian Library record.`
            : "No Custodian Library record is linked; verify the delivering firm against current documentation."}
        </p>
      </div>

      {data.actions.length > 0 && (
        <div className="border-b border-card-border bg-[color:var(--warning-bg)] px-6 py-4">
          <div className="flex items-start gap-2">
            <AlertTriangle
              size={15}
              className="mt-0.5 shrink-0 text-[color:var(--warning)]"
            />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--warning)]">
                Confirm before generating
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-foreground">
                {data.actions.map((action) => (
                  <li key={action.code}>{action.message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4 px-6 py-5">
        {data.secondaryClientSignatureRequired && (
          <div className="rounded-lg border border-[color:var(--warning)] bg-[color:var(--warning-bg)] p-4 text-foreground">
            <p className="text-sm font-semibold">
              Joint account — two client signatures required
            </p>
            <p className="mt-1 text-xs leading-relaxed">
              Both account holders must sign the transfer form and any
              populated letter of authorization. The Custodian Library still
              controls whether those signatures may be electronic or must be
              wet signatures.
            </p>
          </div>
        )}

        {data.inheritedAccountTitleReviewRequired && (
          <div className="rounded-lg border border-[color:var(--warning)] bg-[color:var(--warning-bg)] p-4">
            <label
              htmlFor="manual-transfer-delivering-account-title"
              className="text-xs font-semibold uppercase tracking-wide text-[color:var(--warning)]"
            >
              Delivering account title from current statement
            </label>
            <input
              id="manual-transfer-delivering-account-title"
              value={deliveringAccountTitle}
              required
              onChange={(event) => {
                setDeliveringAccountTitleOverride(event.target.value);
                setDeliveringAccountTitleVerified(false);
              }}
              className="mt-1 block w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground"
              aria-describedby="manual-transfer-delivering-account-title-help"
            />
            <p
              id="manual-transfer-delivering-account-title-help"
              className="mt-1 text-xs leading-relaxed text-foreground"
            >
              The client name is only a tracker suggestion. Replace it with the
              exact registration shown on the current delivering statement.
            </p>
            <p className="mt-2 text-sm font-semibold text-foreground">
              {inheritedTitleMismatch
                ? "Titles differ — the letter of authorization will be populated."
                : "Titles match — Custodian Library LOA guidance still applies."}
            </p>
            <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={deliveringAccountTitleVerified}
                onChange={(event) =>
                  setDeliveringAccountTitleVerified(event.target.checked)
                }
                className="mt-0.5 h-4 w-4 rounded border-card-border"
              />
              <span>
                I confirmed this delivering title against the current
                statement.
              </span>
            </label>
          </div>
        )}

        {data.candidates.length > 1 && (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              Form workflow
            </span>
            <select
              value={selectedRuleId}
              onChange={(event) => setSelectedRuleId(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground"
            >
              <option value="">Choose using current documentation</option>
              {data.candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
          </label>
        )}

        {selectedRule && selectedHandling?.mode === "CLIENT_DIRECTED" && (
          <div>
            <label
              htmlFor="manual-transfer-asset-instruction"
              className="text-xs font-semibold uppercase tracking-wide text-muted"
            >
              Client asset instruction
            </label>
            <select
              id="manual-transfer-asset-instruction"
              value={assetInstruction}
              onChange={(event) =>
                setAssetInstructions((current) => ({
                  ...current,
                  [selectedRule.id]: event.target.value as AssetInstruction,
                }))
              }
              className="mt-1 block w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground"
            >
              <option value="IN_KIND">Transfer in kind</option>
              <option value="LIQUIDATE">Liquidate</option>
            </select>
            <p className="mt-1 text-xs text-muted">
              {selectedHandling.preferredInstruction === "LIQUIDATE"
                ? "Liquidation is preferred for this custodian; follow the client’s request."
                : "In kind is assumed; confirm against the client’s request before downloading."}
            </p>
          </div>
        )}

        {selectedRule?.requiresVerifiedReceivingAccountNumber && (
          <div className="rounded-lg border border-[color:var(--warning)] bg-[color:var(--warning-bg)] p-4">
            <label
              htmlFor="manual-transfer-receiving-account-number"
              className="text-xs font-semibold uppercase tracking-wide text-[color:var(--warning)]"
            >
              Verified receiving / house account number
            </label>
            <input
              id="manual-transfer-receiving-account-number"
              value={receivingAccountNumber}
              required
              onChange={(event) => {
                setReceivingAccountNumbers((current) => ({
                  ...current,
                  [selectedRule.id]: event.target.value,
                }));
                setVerifiedReceivingAccountRules((current) => ({
                  ...current,
                  [selectedRule.id]: false,
                }));
              }}
              className="mt-1 block w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 font-mono text-sm text-foreground"
              aria-describedby="manual-transfer-receiving-account-help"
            />
            <p
              id="manual-transfer-receiving-account-help"
              className="mt-1 text-xs leading-relaxed text-foreground"
            >
              {data.custodian?.receivingAccountNumber
                ? `${data.custodian.receivingAccountNumber} is the last-known Victory value from the Custodian Library. Verify it with Apex MF Ops and replace it here if the current value differs.`
                : "No last-known Victory value is stored in the Custodian Library. Enter the value supplied by Apex MF Ops."}
            </p>
            <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={
                  verifiedReceivingAccountRules[selectedRule.id] === true
                }
                onChange={(event) =>
                  setVerifiedReceivingAccountRules((current) => ({
                    ...current,
                    [selectedRule.id]: event.target.checked,
                  }))
                }
                className="mt-0.5 h-4 w-4 rounded border-card-border"
              />
              <span>
                I verified this receiving/house number with Apex MF Ops.
              </span>
            </label>
          </div>
        )}

        <div className="rounded-lg border border-[color:var(--warning)] bg-[color:var(--warning-bg)] p-4">
          <label
            htmlFor="manual-transfer-apex-account-title"
            className="text-xs font-semibold uppercase tracking-wide text-[color:var(--warning)]"
          >
            Receiving Apex account title
          </label>
          <input
            id="manual-transfer-apex-account-title"
            value={apexAccountTitle}
            required
            onChange={(event) => {
              setApexAccountTitleOverride(event.target.value);
              setApexAccountTitleVerifiedOverride(false);
              setApexTitleSaveError(null);
            }}
            className="mt-1 block w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground"
            aria-describedby="manual-transfer-apex-account-title-help"
          />
          <p
            id="manual-transfer-apex-account-title-help"
            className="mt-1 text-xs leading-relaxed text-foreground"
          >
            {apexAccountTitleVerified && apexTitleConfirmation
              ? "This is the saved title previously confirmed against Apex. Edit it if the registration has changed."
              : "This is a Client Name - Account Type suggestion from the tracker, not a live Apex title. Edit it to match Apex exactly before generating the form."}
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={apexAccountTitleVerified}
              disabled={savingApexTitle || apexAccountTitle.trim().length === 0}
              onChange={(event) =>
                void saveApexTitleConfirmation(event.target.checked)
              }
              className="mt-0.5 h-4 w-4 rounded border-card-border"
            />
            <span>
              {savingApexTitle
                ? "Saving confirmed Apex title…"
                : "I confirmed this account title matches Apex."}
            </span>
          </label>
          {apexAccountTitleVerified && apexTitleConfirmation?.confirmedAt && (
            <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-[color:var(--success)]">
              <CheckCircle2 size={13} />
              Saved {new Date(apexTitleConfirmation.confirmedAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
              {apexTitleConfirmation.confirmedBy
                ? ` by ${apexTitleConfirmation.confirmedBy}`
                : ""}
            </div>
          )}
          {apexTitleSaveError && (
            <p className="mt-2 text-xs font-medium text-[color:var(--danger)]">
              {apexTitleSaveError}
            </p>
          )}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {data.candidates.map((candidate) => (
            <div
              key={candidate.id}
              className="rounded-lg border border-card-border bg-[var(--bg-hover)] p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-foreground">
                  {candidate.displayName}
                </p>
                {candidate.isDefaultFallback && (
                  <span className="rounded-full border border-card-border bg-[var(--bg-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Standard default
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">
                {TEMPLATE_LABELS[candidate.template]}
              </p>
              {candidate.apexTransferSelection && (
                <p className="mt-2 text-xs text-foreground">
                  Apex section:{" "}
                  {(getApexTransferSelection(
                    candidate,
                    candidate.id === selectedRule?.id
                      ? assetInstruction
                      : undefined
                  ) ?? candidate.apexTransferSelection)
                    .toLowerCase()
                    .replaceAll("_", " ")}
                </p>
              )}
              {candidate.assetHandling?.mode === "FIXED" && (
                <p className="mt-2 text-sm font-semibold text-foreground">
                  Asset handling: Liquidate only
                </p>
              )}
              {getAssetHandlingRule(candidate).mode === "CLIENT_DIRECTED" && (
                <>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    Asset handling: Client-directed — in kind or liquidate
                  </p>
                  {candidate.assetHandling?.mode === "CLIENT_DIRECTED" &&
                    candidate.assetHandling.watchout && (
                    <p className="mt-1 text-xs text-[color:var(--warning)]">
                      {candidate.assetHandling.watchout}
                    </p>
                  )}
                </>
              )}
              {candidate.apexSignatureRequirement === "WET_REQUIRED" && (
                <p className="mt-2 text-sm font-semibold text-foreground">
                  Apex signature: Wet signature required
                </p>
              )}
              {candidate.note && (
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {candidate.note}
                </p>
              )}
              {candidate.suggestedDeliveringFirm && (
                <div className="mt-3 rounded-md border border-dashed border-card-border px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Historical suggestion — verify
                  </p>
                  {formatSuggestedFirm(candidate.suggestedDeliveringFirm).map(
                    (line) => (
                      <p key={line} className="mt-0.5 text-xs text-foreground">
                        {line}
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {data.discrepancies.map((discrepancy) => (
          <div
            key={discrepancy.field}
            className="rounded-lg border border-[color:var(--warning)] bg-[color:var(--warning-bg)] p-3 text-sm text-foreground"
          >
            <p className="font-semibold">
              DTC review: transfer {discrepancy.recordedValue} · historical
              suggestion {discrepancy.suggestedValue}
            </p>
            <p className="mt-1 text-xs">{discrepancy.message}</p>
          </div>
        ))}

        {data.custodian && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Custodian Library — source of truth
            </p>
            <dl className="mt-2 grid gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["LOA", data.custodian.letterOfAcceptance],
                [
                  "Receiving / house account",
                  data.custodian.receivingAccountNumber,
                ],
                ["Medallion", data.custodian.medallionRequired],
                ["Client signature", data.custodian.signature],
                ["Return method", data.custodian.returnMethod],
                ["Liquidation guidance", data.custodian.liquidationMethod],
              ]
                .filter(
                  ([label, value]) =>
                    label !== "Receiving / house account" ||
                    Boolean(value?.trim())
                )
                .map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                      {label}
                    </dt>
                    <dd className="mt-0.5 text-sm text-foreground">
                      {valueOrMissing(value)}
                    </dd>
                  </div>
                ))}
            </dl>
            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                Watchouts
              </p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground">
                {valueOrMissing(data.custodian.watchouts)}
              </p>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-card-border px-3 py-2">
          {data.sourceGuidance.map((guidance) => (
            <p key={guidance} className="text-xs leading-relaxed text-muted">
              {guidance}
            </p>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-card-border bg-[var(--bg-hover)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Prefilled Apex transfer form
            </p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
              SSN/Tax ID, delivering address, signatures, and medallion remain
              blank for confirmation and secure completion.{" "}
              {data.secondaryClientSignatureRequired
                ? "Both client signature lines must be completed for this joint account. "
                : ""}
              Mutual-fund cash elections follow the selected liquidation
              instruction.
            </p>
            {partialAssetSelection?.required && (
              <p
                className={`mt-2 max-w-2xl text-xs font-medium ${
                  partialAssetSelectionReady
                    ? "text-[color:var(--success)]"
                    : "text-[color:var(--warning)]"
                }`}
              >
                Partial-transfer holdings: {partialAssetSelection.included} included, {partialAssetSelection.excluded} excluded, {partialAssetSelection.undecided} undecided.
                {!partialAssetSelectionReady &&
                  " Review the saved transfer selections below before generating."}
              </p>
            )}
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
              Mapped holdings already saved on this transfer populate the fund
              rows. Generating the form does not run a new asset-mapping sync.
            </p>
            {generationError && (
              <p className="mt-2 text-xs font-medium text-[color:var(--danger)]">
                {generationError}
              </p>
            )}
            {generationSaved && <p role="status" className="mt-2 text-xs font-medium text-[color:var(--success)]">Saved to this transfer’s paperwork history. You can download it again without regenerating.</p>}
          </div>
          <button
            type="button"
            disabled={
              !selectedRule ||
              generating ||
              unsavedSelections ||
              !receivingAccountNumberReady ||
              !apexAccountTitleReady ||
              !deliveringAccountTitleReady ||
              !partialAssetSelectionReady
            }
            onClick={downloadForm}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Download size={15} />
            )}
            {generating ? "Generating…" : "Download prefilled form"}
          </button>
        </div>
        {partialAssetSelection?.required && <PartialTransferSelections
          key={acatId}
          acatId={acatId}
          onDirtyChange={setUnsavedSelections}
          onSaved={async () => { await mutate(); }}
        />}
      </div>
    </section>
  );
}
