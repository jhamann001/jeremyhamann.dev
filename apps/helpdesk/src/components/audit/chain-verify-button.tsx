"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, ShieldCheck, ShieldX } from "lucide-react";
import type { ActionResult, ChainVerification } from "@/types/domain";
import { verifyAuditChain } from "@/server/audit-log.actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";

const REASON_TEXT: Readonly<Record<ChainVerification["reason"], string>> = {
  OK: "every row re-hashes to its stored hash and links to its predecessor",
  HASH_MISMATCH: "a row's hashed columns no longer produce its stored hash",
  PREV_HASH_MISMATCH: "a row's prevHash does not equal the hash of the row before it",
  EMPTY: "the ledger has no rows",
};

/**
 * Runs `verifyAuditChain` (compliance-only server action, which records AUDIT_CHAIN_VERIFIED itself) and
 * shows the verdict as a green or red Alert. Renders as a fragment so the button sits in the page header
 * while the Alert (basis-full, order-last) wraps onto its own full-width line beneath the header row; in
 * the phone header's 2-col grid the same Alert spans both columns (col-span-full, order-last).
 */
export function ChainVerifyButton(): React.JSX.Element {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult<ChainVerification> | null>(null);

  function onVerify(): void {
    startTransition(async () => {
      const next = await verifyAuditChain();
      setResult(next);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full md:w-auto"
        onClick={onVerify}
        disabled={pending}
        aria-busy={pending || undefined}
        data-audit-verify
      >
        {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <ShieldCheck aria-hidden />}
        {pending ? "Verifying…" : "Verify chain"}
      </Button>

      {result === null ? null : result.ok ? (
        result.data.ok ? (
          <Alert
            className="order-last col-span-full basis-full border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 *:data-[slot=alert-description]:text-emerald-900/80 dark:*:data-[slot=alert-description]:text-emerald-200/80"
            data-chain-verdict="ok"
          >
            <ShieldCheck aria-hidden />
            <AlertTitle>
              {result.data.reason === "EMPTY" ? "Ledger is empty — nothing to verify" : "Chain verified"}
            </AlertTitle>
            <AlertDescription>
              {result.data.reason === "EMPTY" ? (
                <span>{REASON_TEXT.EMPTY}.</span>
              ) : (
                <span>
                  {result.data.checkedRows.toLocaleString()} rows checked, seq{" "}
                  <span className="font-mono tabular-nums">{result.data.fromSeq}</span>–
                  <span className="font-mono tabular-nums">{result.data.toSeq}</span>; {REASON_TEXT.OK}.
                </span>
              )}
              <span suppressHydrationWarning>
                {" "}
                Verified {formatDateTime(result.data.verifiedAt)}. This verification was itself recorded.
              </span>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive" className="order-last col-span-full basis-full" data-chain-verdict="fail">
            <ShieldX aria-hidden />
            <AlertTitle>
              Chain broken at seq <span className="font-mono tabular-nums">{result.data.firstBadSeq ?? "?"}</span>
            </AlertTitle>
            <AlertDescription>
              <span>
                {result.data.reason}: {REASON_TEXT[result.data.reason]}. {result.data.checkedRows.toLocaleString()}{" "}
                rows checked from seq <span className="font-mono tabular-nums">{result.data.fromSeq}</span>.
              </span>
              <span suppressHydrationWarning>
                {" "}
                Verified {formatDateTime(result.data.verifiedAt)}. This result was recorded as AUDIT_CHAIN_VERIFIED;
                escalate per the books-and-records runbook.
              </span>
            </AlertDescription>
          </Alert>
        )
      ) : (
        <Alert variant="destructive" className="order-last col-span-full basis-full" data-chain-verdict="error">
          <ShieldX aria-hidden />
          <AlertTitle>Verification did not run</AlertTitle>
          <AlertDescription>
            {result.code === "FORBIDDEN"
              ? "Your groups do not grant audit:verify. The attempt has been recorded."
              : result.code === "UNAUTHORIZED"
                ? "Your session has ended. Sign in again."
                : result.message}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
