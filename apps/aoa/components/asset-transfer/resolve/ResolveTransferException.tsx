"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { resolveDecisionCase } from "@/app/(authenticated)/(workflow)/decision-center/actions";
import { btnClass } from "@/components/asset-transfer/workspace/ui";
import { Button } from "@/components/ui";
import styles from "./ResolveTransferException.module.css";

const RESOLUTION_CODE = "TRANSFER_EXCEPTION_APPROVED";

export function ResolveTransferException({
  decisionId,
  baseVersion,
  appearance,
}: {
  decisionId: string;
  baseVersion: number;
  appearance: "workspace" | "record";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await resolveDecisionCase({
        decisionId,
        baseVersion,
        resolutionCode: RESOLUTION_CODE,
        resolutionSummary: summary,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSummary("");
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return appearance === "workspace" ? (
      <button type="button" className={btnClass({ tiny: true, primary: true })} onClick={() => setOpen(true)}>Resolve</button>
    ) : (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>Resolve</Button>
    );
  }

  return (
    <form className={styles.form} aria-label="Resolve exception" onSubmit={submit}>
      <label>
        Approved exception resolution
        <textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={1000}
          required
          placeholder="Record the specific resolution and any context the execution owner needs."
        />
      </label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        {appearance === "workspace" ? (
          <>
            <button className={btnClass({ tiny: true, primary: true })} type="submit" disabled={pending || summary.trim().length === 0}>
              {pending ? "Saving…" : "Approve resolution"}
            </button>
            <button className={btnClass({ tiny: true })} type="button" onClick={() => setOpen(false)}>Cancel</button>
          </>
        ) : (
          <>
            <Button type="submit" size="sm" disabled={pending || summary.trim().length === 0}>
              {pending ? "Saving…" : "Approve resolution"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </>
        )}
      </div>
    </form>
  );
}
