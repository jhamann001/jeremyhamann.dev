"use client";

import styles from "./Select.module.css";

// Generic inline select styled for a table cell. StatusSelect / PrioritySelect
// are typed wrappers; DocCard uses it directly for doc status.
export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <select
      className={styles.select}
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
