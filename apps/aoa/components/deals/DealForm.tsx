"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  FUNDING_TYPES,
  FUNDING_TYPE_CASH,
  FUNDING_TYPE_OTHER,
  FUNDING_TYPE_ROLLOVER,
  ROLLING_INTO_OPTIONS,
  STAGE_ORDER,
  stageLabel,
  MASKED_CEDAR_RIDGE_ID,
} from "@/lib/data/deal-types";
import type { DealValidationError } from "@/lib/data/deal-validate";
import { Button } from "@/components/ui";
import { createDeal, updateDeal } from "@/app/(authenticated)/deals/actions";
import {
  clientsForHousehold,
  findClientByFullName,
  type DealFormValues,
  type DealSuggestions,
} from "./deal-form";
import styles from "./DealForm.module.css";

// The ONE shared create/edit deal form (WO ticket, TDD §6). Controlled state
// seeded from `initialValues`, so a failed action re-renders with everything
// the user typed (no data loss). Field-keyed errors from the FROZEN
// validateDealInput render inline under the offending input; non-field errors
// (e.g. a DB/RLS write rejection) render as a banner.
//
// NOT on the form: stage_raw / sf_deal_id / source / person+potential AUM
// (import-only), plaid_linked (removed from all UI — scope change, the owner
// 2026-07-01; DB default persists), and — since D6 (WO ticket) — owner +
// secondary owner: both are hidden from all /deals UI. Create still silently
// records owner_name = the signed-in user (server-side, in the action);
// edits carry the stored owner values through untouched.

// Validator fields that have a dedicated input; anything else (name, source,
// created_date, form) surfaces in the banner.
const FIELD_INPUTS = new Set([
  "client_first_name",
  "client_last_name",
  "household_name",
  "household_sf_id",
  "amount",
  "stage",
  "close_date",
  "cedar_ridge_user_id",
  "statements",
  "account_type",
  "funding_other",
  "employer",
  "rolling_into",
  "account_last4",
  "transferring_firm",
]);

export function DealForm({
  mode,
  dealId,
  initialValues,
  onCancel,
  suggestions,
  canViewCedarRidge,
  cedarRidgeMasked,
}: {
  mode: "create" | "edit";
  dealId?: string;
  initialValues: DealFormValues;
  /** Modal supplies a close callback; pages fall back to router.push("/deals"). */
  onCancel?: () => void;
  /** D8 typeahead datalists from existing deals; absent → plain inputs. */
  suggestions?: DealSuggestions;
  /** ADMIN/OPERATIONS may see + edit the real cedar_ridge_user_id. */
  canViewCedarRidge: boolean;
  /** True when a real cedar_ridge_user_id was withheld for this caller's role. */
  cedarRidgeMasked: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const [values, setValues] = useState<DealFormValues>(initialValues);
  const [errors, setErrors] = useState<DealValidationError[]>([]);
  const [pending, startTransition] = useTransition();

  const fieldError = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of errors) if (!map.has(e.field)) map.set(e.field, e.message);
    return map;
  }, [errors]);
  const bannerErrors = errors.filter((e) => !FIELD_INPUTS.has(e.field));

  const set = <K extends keyof DealFormValues>(key: K, v: DealFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  // D8 funding-type select: the exact FUNDING_TYPES list, with the current
  // stored value PREPENDED when it isn't in the list (legacy/imported values —
  // the mockup rule; "" also prepends so seeding a legacy row or starting a
  // create never silently rewrites the funding type).
  const fundingOptions = useMemo(() => {
    const t = values.account_type;
    return (FUNDING_TYPES as readonly string[]).includes(t)
      ? (FUNDING_TYPES as readonly string[])
      : [t, ...FUNDING_TYPES];
  }, [values.account_type]);
  const isOther = values.account_type === FUNDING_TYPE_OTHER;
  const isRollover = values.account_type === FUNDING_TYPE_ROLLOVER;
  const isCash = values.account_type === FUNDING_TYPE_CASH;
  // A stored Other-typed / legacy value renders as a prepended option (not
  // "Other"), but it is still the Other bucket — its employer must stay
  // visible and editable (the imported profit-sharing/RSU/403b rows).
  const isNonReserved =
    values.account_type !== "" &&
    !(FUNDING_TYPES as readonly string[]).includes(values.account_type);

  const setFundingType = (t: string) =>
    setValues((prev) => ({
      ...prev,
      account_type: t,
      // Cash disables AND clears account #/firm (mockup behavior; the server
      // forces both null regardless).
      ...(t === FUNDING_TYPE_CASH
        ? { account_last4: "", transferring_firm: "" }
        : {}),
    }));

  // D8 typeahead: the client datalist narrows to the typed household's
  // members; picking a known client fills first/last and auto-fills its
  // household when derivable. Without suggestions everything stays plain.
  const clientOptions = useMemo(
    () => (suggestions ? clientsForHousehold(suggestions, values.household_name) : []),
    [suggestions, values.household_name],
  );
  const setClientFirstName = (v: string) => {
    const picked = suggestions ? findClientByFullName(suggestions, v) : null;
    if (!picked) {
      set("client_first_name", v);
      return;
    }
    setValues((prev) => ({
      ...prev,
      client_first_name: picked.first,
      client_last_name: picked.last,
      ...(picked.household_name != null
        ? {
            household_name: picked.household_name,
            household_sf_id: picked.household_sf_id ?? prev.household_sf_id,
          }
        : {}),
    }));
  };

  const submit = () => {
    startTransition(async () => {
      const result =
        mode === "create"
          ? await createDeal(values)
          : await updateDeal(dealId!, values);
      // Success redirects inside the action; only failures return.
      if (result && !result.ok) setErrors(result.errors);
    });
  };

  const cancel = () => {
    if (onCancel) onCancel();
    else router.push("/deals");
  };

  const err = (field: string) =>
    fieldError.has(field) ? (
      <span className={styles.error} role="alert">
        {fieldError.get(field)}
      </span>
    ) : null;

  const inputProps = (field: string) =>
    fieldError.has(field) ? { "aria-invalid": true, className: styles.inputBad } : {};

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
            onChange={(e) => setClientFirstName(e.target.value)}
            list={suggestions ? `${uid}-clients` : undefined}
            autoComplete="off"
            {...inputProps("client_first_name")}
          />
          {suggestions && (
            <datalist id={`${uid}-clients`}>
              {clientOptions.map((c) => (
                <option key={c.full} value={c.full} />
              ))}
            </datalist>
          )}
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
          <span className={styles.label}>Household name</span>
          <input
            value={values.household_name}
            onChange={(e) => set("household_name", e.target.value)}
            list={suggestions ? `${uid}-households` : undefined}
            autoComplete="off"
            {...inputProps("household_name")}
          />
          {suggestions && (
            <datalist id={`${uid}-households`}>
              {suggestions.households.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          )}
          {err("household_name")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Amount (USD) *</span>
          <input
            inputMode="decimal"
            value={values.amount}
            onChange={(e) => set("amount", e.target.value)}
            placeholder="250000"
            {...inputProps("amount")}
          />
          {err("amount")}
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
          {err("stage")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Expected close date</span>
          <input
            type="date"
            value={values.close_date}
            onChange={(e) => set("close_date", e.target.value)}
            {...inputProps("close_date")}
          />
          {err("close_date")}
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Cedar Ridge user id</span>
          {canViewCedarRidge ? (
            <input
              value={values.cedar_ridge_user_id}
              onChange={(e) => set("cedar_ridge_user_id", e.target.value)}
              placeholder="Optional — prospects lack one"
              {...inputProps("cedar_ridge_user_id")}
            />
          ) : (
            <input
              // Display-only: NOT bound to form state, so the real value can
              // never enter `values` and the masked dots are never submitted
              // as data.
              value={cedarRidgeMasked ? MASKED_CEDAR_RIDGE_ID : ""}
              readOnly
              disabled
              aria-label="Cedar Ridge user id (hidden for your role)"
              placeholder="Hidden"
            />
          )}
          {err("cedar_ridge_user_id")}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Account type</span>
          <select
            value={values.account_type}
            onChange={(e) => setFundingType(e.target.value)}
            {...inputProps("account_type")}
          >
            {fundingOptions.map((t) => (
              <option key={t} value={t}>
                {t === "" ? "—" : t}
              </option>
            ))}
          </select>
          {err("account_type")}
        </label>
        {isOther && (
          <label className={styles.field}>
            <span className={styles.label}>Specify account type</span>
            <input
              value={values.funding_other}
              onChange={(e) => set("funding_other", e.target.value)}
              placeholder="Describe the account type"
              {...inputProps("funding_other")}
            />
            {err("funding_other")}
          </label>
        )}
        {/* D8 follow-on: Employer also reveals for the Other bucket — the
            "Other" pick itself AND a stored Other-typed/legacy value (real
            Other-typed plans carry one: profit-sharing, RSUs, 403b). */}
        {(isRollover || isOther || isNonReserved) && (
          <label className={styles.field}>
            <span className={styles.label}>
              Employer{" "}
              {!isRollover && <span className={styles.hint}>(optional)</span>}
            </span>
            <input
              value={values.employer}
              onChange={(e) => set("employer", e.target.value)}
              placeholder="e.g. Google"
              {...inputProps("employer")}
            />
            {err("employer")}
          </label>
        )}
        {isRollover && (
          <label className={styles.field}>
            <span className={styles.label}>
              Rolling into <span className={styles.hint}>(optional)</span>
            </span>
            <select
              value={values.rolling_into}
              onChange={(e) => set("rolling_into", e.target.value)}
              {...inputProps("rolling_into")}
            >
              <option value="">— not specified</option>
              {ROLLING_INTO_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {err("rolling_into")}
          </label>
        )}
        <label className={`${styles.field} ${isCash ? styles.fieldOff : ""}`.trim()}>
          <span className={styles.label}>Account last 4</span>
          <input
            // Relaxed rule (D8 follow-on): real account #s aren't always 4
            // digits ('81-154', 'M1DU') — free text up to 10 chars.
            maxLength={10}
            value={values.account_last4}
            onChange={(e) => set("account_last4", e.target.value)}
            placeholder={isCash ? "n/a — cash" : "1234"}
            disabled={isCash}
            {...inputProps("account_last4")}
          />
          {err("account_last4")}
        </label>

        <label className={`${styles.field} ${isCash ? styles.fieldOff : ""}`.trim()}>
          <span className={styles.label}>Transferring firm</span>
          <input
            value={values.transferring_firm}
            onChange={(e) => set("transferring_firm", e.target.value)}
            placeholder={isCash ? "n/a — cash" : "Fidelity"}
            disabled={isCash}
            {...inputProps("transferring_firm")}
          />
          {err("transferring_firm")}
        </label>
        <label className={`${styles.field} ${styles.check}`}>
          <input
            type="checkbox"
            checked={values.statements}
            onChange={(e) => set("statements", e.target.checked)}
          />
          <span className={styles.label}>Statements on file</span>
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
              ? "Create deal"
              : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
