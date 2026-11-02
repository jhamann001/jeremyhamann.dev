"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  STAGE_ORDER,
  TRANSFER_OWNERS,
  stageLabel,
  type TransferOwner,
} from "@/lib/data/transfer-types";
import type { TransferValidationError } from "@/lib/data/transfer-validate";
import { Button } from "@/components/ui";
import {
  createTransfer,
  updateTransfer,
} from "@/app/(authenticated)/asset-transfer/actions";
import type { TransferFormValues } from "./transfer-form";
import styles from "./TransferForm.module.css";

// The ONE shared create/edit transfer form (WO ticket, TDD §6) — the deals
// DealForm idiom: controlled state seeded from `initialValues`, so a failed
// action re-renders with everything the user typed. Field-keyed errors from
// the FROZEN validateTransferInput render inline; non-field errors (a DB/RLS
// write rejection — the VIEWER path) render as the banner. Create seeds the
// chosen stage's DEFAULT_TASKS server-side; source is pinned to APP.

const OWNER_LABEL: Record<TransferOwner, string> = {
  OPERATIONS: "Operations",
  CLIENT_SERVICE: "Client Service",
  ADVISOR: "Advisor",
};

// Validator fields with a dedicated input; anything else (source, form)
// surfaces in the banner.
const FIELD_INPUTS = new Set([
  "client_first_name",
  "client_last_name",
  "client_sf_id",
  "household_name",
  "household_sf_id",
  "value",
  "stage",
  "owner_kind",
  "owner_name",
  "next_step",
  "next_step_owner",
  "pending_nudge",
  "acat_transfer_id",
]);

export function TransferForm({
  mode,
  transferId,
  initialValues,
  focusAcat = false,
}: {
  mode: "create" | "edit";
  transferId?: string;
  initialValues: TransferFormValues;
  // Deep-link hint from the detail page's "Link live ACAT status" CTA
  // (?focus=acat): scroll the ACAT field into view, focus it, and briefly
  // highlight it on mount so the buried field reads as the linking target.
  focusAcat?: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<TransferFormValues>(initialValues);
  const [errors, setErrors] = useState<TransferValidationError[]>([]);
  const [pending, startTransition] = useTransition();
  const acatInputRef = useRef<HTMLInputElement>(null);
  const [acatHighlight, setAcatHighlight] = useState(false);

  useEffect(() => {
    if (!focusAcat) return;
    const el = acatInputRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
    setAcatHighlight(true);
    const t = setTimeout(() => setAcatHighlight(false), 1600);
    return () => clearTimeout(t);
  }, [focusAcat]);

  const fieldError = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of errors) if (!map.has(e.field)) map.set(e.field, e.message);
    return map;
  }, [errors]);
  const bannerErrors = errors.filter((e) => !FIELD_INPUTS.has(e.field));

  const set = <K extends keyof TransferFormValues>(
    key: K,
    v: TransferFormValues[K],
  ) => setValues((prev) => ({ ...prev, [key]: v }));

  const submit = () => {
    startTransition(async () => {
      const result =
        mode === "create"
          ? await createTransfer(values)
          : await updateTransfer(transferId!, values);
      // Success redirects inside the action; only failures return.
      if (result && !result.ok) setErrors(result.errors);
    });
  };

  const cancel = () => {
    router.push(
      mode === "edit" && transferId
        ? `/asset-transfer/${transferId}`
        : "/asset-transfer",
    );
  };

  const err = (field: string) =>
    fieldError.has(field) ? (
      <span className={styles.error} role="alert">
        {fieldError.get(field)}
      </span>
    ) : null;

  const inputProps = (field: string) =>
    fieldError.has(field)
      ? { "aria-invalid": true, className: styles.inputBad }
      : {};

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      {bannerErrors.length > 0 && (
        <div className={styles.banner} role="alert">
          {bannerErrors.map((e) => (
            <p key={`${e.field}:${e.message}`}>{e.message}</p>
          ))}
        </div>
      )}

      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.label}>Client first name *</span>
          <input
            value={values.client_first_name}
            onChange={(e) => set("client_first_name", e.target.value)}
            {...inputProps("client_first_name")}
          />
          {err("client_first_name")}
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Client last name *</span>
          <input
            value={values.client_last_name}
            onChange={(e) => set("client_last_name", e.target.value)}
            {...inputProps("client_last_name")}
          />
          {err("client_last_name")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Client SF id</span>
          <input
            value={values.client_sf_id}
            onChange={(e) => set("client_sf_id", e.target.value)}
            placeholder="Optional — prospects lack one"
            {...inputProps("client_sf_id")}
          />
          {err("client_sf_id")}
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Household name</span>
          <input
            value={values.household_name}
            onChange={(e) => set("household_name", e.target.value)}
            {...inputProps("household_name")}
          />
          {err("household_name")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Household SF id</span>
          <input
            value={values.household_sf_id}
            onChange={(e) => set("household_sf_id", e.target.value)}
            placeholder="HH-…"
            {...inputProps("household_sf_id")}
          />
          {err("household_sf_id")}
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Est. transfer value (USD) *</span>
          <input
            inputMode="decimal"
            value={values.value}
            onChange={(e) => set("value", e.target.value)}
            placeholder="500000"
            {...inputProps("value")}
          />
          {err("value")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Stage *</span>
          <select
            value={values.stage}
            onChange={(e) => set("stage", e.target.value)}
            {...inputProps("stage")}
          >
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </select>
          {mode === "create" && (
            <span className={styles.hint}>
              Creating seeds this stage&apos;s default checklist.
            </span>
          )}
          {err("stage")}
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Owner *</span>
          <select
            value={values.owner_kind}
            onChange={(e) => set("owner_kind", e.target.value)}
            {...inputProps("owner_kind")}
          >
            {TRANSFER_OWNERS.map((o) => (
              <option key={o} value={o}>
                {OWNER_LABEL[o]}
              </option>
            ))}
          </select>
          {err("owner_kind")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Owner name</span>
          <input
            value={values.owner_name}
            onChange={(e) => set("owner_name", e.target.value)}
            placeholder="Display only — optional"
            {...inputProps("owner_name")}
          />
          {err("owner_name")}
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Pending nudge label</span>
          <input
            value={values.pending_nudge}
            onChange={(e) => set("pending_nudge", e.target.value)}
            placeholder="Send asset-decision worksheet"
            {...inputProps("pending_nudge")}
          />
          <span className={styles.hint}>
            Label only — sends live in Smart Nudges.
          </span>
          {err("pending_nudge")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Next step</span>
          <input
            value={values.next_step}
            onChange={(e) => set("next_step", e.target.value)}
            {...inputProps("next_step")}
          />
          {err("next_step")}
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Next step owner</span>
          <input
            value={values.next_step_owner}
            onChange={(e) => set("next_step_owner", e.target.value)}
            placeholder="Operations"
            {...inputProps("next_step_owner")}
          />
          {err("next_step_owner")}
        </label>

        <label id="acat" className={styles.field}>
          <span className={styles.label}>
            ACAT id (tracker record id or Apex transfer id)
          </span>
          <input
            ref={acatInputRef}
            value={values.acat_transfer_id}
            onChange={(e) => set("acat_transfer_id", e.target.value)}
            placeholder="Tracker record id or Apex transfer id"
            className={acatHighlight ? styles.acatHighlight : undefined}
            {...inputProps("acat_transfer_id")}
          />
          <span className={styles.hint}>
            Paste either id to attach live status to this transfer; clear to
            unlink. The id is verified against the Transfer Tracker on save.
          </span>
          {err("acat_transfer_id")}
        </label>
      </div>

      <div className={styles.actions}>
        <Button variant="ghost" type="button" onClick={cancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : mode === "create"
              ? "Create transfer"
              : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
