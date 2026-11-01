"use client";

import {
  ReactNode,
  useEffect,
  useRef,
} from "react";
import { Check, Loader2, Pencil, X as XIcon } from "lucide-react";
import { UseInlineEditApi } from "@/hooks/use-inline-edit";
import MultiCheckSelect from "./MultiCheckSelect";
import ContraCombobox, { ContraOption } from "./ContraCombobox";

export type InlineFieldType =
  | "text"
  | "date"
  | "textarea"
  | "select"
  | "multiselect"
  | "contra";

export interface InlineFieldProps {
  /** Stable identifier passed to the underlying useInlineEdit hook. */
  field: string;
  /** Current persisted value (string-coerced). */
  value: string;
  /** Shared inline-edit hook from the parent. Multiple InlineFields share one hook. */
  edit: UseInlineEditApi;
  type?: InlineFieldType;

  /** Options for `select` and `multiselect`. */
  options?: string[];

  /** Whether a select can be cleared to an empty value. */
  allowEmpty?: boolean;

  /** Contra-combobox plumbing (only used when type === "contra"). */
  contraOptions?: ContraOption[];
  canCreateContra?: boolean;
  onCreateContra?: (name: string) => Promise<void> | void;

  /** Placeholder for empty values in display mode + the editor. */
  placeholder?: string;

  /** Optional renderer for the *display* (non-editing) state. */
  renderValue?: (value: string) => ReactNode;

  /** Decorative icon shown next to the value. */
  icon?: ReactNode;

  /** When false, clicking the value won't enter edit mode. */
  editable?: boolean;

  /** Visual variant. `inline` = compact pill (used in headers), `block` = grows to fill the parent row. */
  variant?: "inline" | "block";

  /** Extra class on the container. */
  className?: string;

  /** Used to compute a stable aria-label / data attribute if needed. */
  ariaLabel?: string;
}

/**
 * Polymorphic inline editor. In "view" state, shows the value with a
 * pencil icon on hover; clicking enters edit mode. In edit mode the
 * appropriate control is rendered and wired to the shared
 * useInlineEdit hook so blur (or Enter) commits the change.
 *
 * Selects auto-commit on change so the user doesn't have to click out.
 * Multiselect and the contra combobox commit on outside-click.
 */
export default function InlineField({
  field,
  value,
  edit,
  type = "text",
  options,
  allowEmpty = true,
  contraOptions = [],
  canCreateContra = false,
  onCreateContra,
  placeholder = "—",
  renderValue,
  icon,
  editable = true,
  variant = "inline",
  className,
  ariaLabel,
}: InlineFieldProps) {
  const isEditing = edit.editingField === field;
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Multiselect and contra editors rely on their internal popover for click-out.
  // The parent InlineField wraps the editor and triggers commit when the user
  // mouses-down outside the wrapper, so the buffer is persisted without a
  // dedicated save button.
  useEffect(() => {
    if (!isEditing) return;
    if (type !== "multiselect" && type !== "contra") return;
    function handler(e: MouseEvent) {
      const target = e.target as Node | null;
      if (wrapperRef.current && target && !wrapperRef.current.contains(target)) {
        void edit.commit();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isEditing, type, edit]);

  const status = edit.status;
  const isSaving = isEditing && status === "saving";

  if (isEditing) {
    const handlers = edit.bind(field);
    return (
      <div
        ref={wrapperRef}
        className={`inline-flex flex-1 items-center gap-2 ${className ?? ""}`}
        data-field={field}
        data-editing="true"
      >
        {renderEditor({
          type,
          value: edit.editValue,
          onChange: edit.change,
          options: options ?? [],
          allowEmpty,
          contraOptions,
          canCreateContra,
          onCreateContra,
          placeholder,
          handlers,
          commitWith: (v: string) => void edit.commit(v),
          variant,
        })}
        {isSaving ? (
          <span
            data-status="saving"
            aria-label="Saving"
            className="inline-flex items-center text-muted"
          >
            <Loader2 size={12} className="animate-spin" />
          </span>
        ) : null}
        <button
          type="button"
          onMouseDown={(e) => {
            // Beat the input's blur — beginCancel() makes the impending
            // commit a no-op so this click reliably cancels the edit.
            e.preventDefault();
            edit.beginCancel();
          }}
          onClick={edit.cancel}
          aria-label="Cancel edit"
          className="rounded p-0.5 text-muted hover:text-foreground"
        >
          <XIcon size={12} />
        </button>
      </div>
    );
  }

  const displayed = value === "" ? "" : value;

  return (
    <span
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={ariaLabel ?? `Edit ${field}`}
      data-field={field}
      data-editing="false"
      onClick={() => editable && edit.start(field, value)}
      onKeyDown={(e) => {
        if (!editable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          edit.start(field, value);
        }
      }}
      title={editable ? "Click to edit" : undefined}
      className={`group inline-flex items-center gap-1 rounded-sm ${editable ? "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" : ""} ${className ?? ""}`}
    >
      {icon}
      {renderValue ? (
        renderValue(displayed)
      ) : displayed ? (
        <span className="break-all">{displayed}</span>
      ) : (
        <span className="italic text-muted-faint">{placeholder}</span>
      )}
      {editable && (
        <Pencil
          size={11}
          className="shrink-0 text-muted opacity-40 transition group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      )}
      {status === "saved" && edit.lastSavedField === field ? (
        <span
          data-status="saved"
          aria-label="Saved"
          className="inline-flex items-center text-[color:var(--success)]"
        >
          <Check size={11} />
        </span>
      ) : null}
    </span>
  );
}

interface EditorProps {
  type: InlineFieldType;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  allowEmpty: boolean;
  contraOptions: ContraOption[];
  canCreateContra: boolean;
  onCreateContra?: (name: string) => Promise<void> | void;
  placeholder: string;
  handlers: ReturnType<UseInlineEditApi["bind"]>;
  commitWith: (value: string) => void;
  variant: "inline" | "block";
}

function renderEditor({
  type,
  value,
  onChange,
  options,
  allowEmpty,
  contraOptions,
  canCreateContra,
  onCreateContra,
  placeholder,
  handlers,
  commitWith,
  variant,
}: EditorProps) {
  const widthClass = variant === "block" ? "flex-1" : "w-32";
  const baseInput = `${widthClass} rounded border border-accent bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30`;

  switch (type) {
    case "select": {
      // Preserve an off-list stored value (e.g. a departed advisor like
      // "Sam Ortiz"/"Dana Pruitt" that's no longer in ADVISOR_OPTIONS): render
      // it as a selected option so opening the editor never blanks it and
      // saving without changing it never silently clears the historical value.
      // New records still can't pick it — it only appears on records already
      // holding that value.
      const selectOptions =
        value && !options.includes(value) ? [value, ...options] : options;
      return (
        <select
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next);
            commitWith(next);
          }}
          {...handlers}
          className={baseInput}
        >
          {allowEmpty ? <option value="">—</option> : null}
          {selectOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    case "multiselect":
      return (
        <MultiCheckSelect
          value={value}
          onChange={onChange}
          options={options}
          placeholder={placeholder}
          autoFocus
        />
      );
    case "contra":
      return (
        <ContraCombobox
          value={value}
          onChange={onChange}
          options={contraOptions}
          canCreate={canCreateContra}
          onCreate={onCreateContra}
          placeholder={placeholder}
          autoFocus
        />
      );
    case "textarea":
      return (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...handlers}
          rows={3}
          className={`${widthClass} resize-none rounded border border-accent bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30`}
        />
      );
    case "date":
      return (
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...handlers}
          className={baseInput}
        />
      );
    case "text":
    default:
      return (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...handlers}
          placeholder={placeholder}
          className={baseInput}
        />
      );
  }
}
