import styles from "../NewRequestForm.module.css";

export function FieldLabel({ htmlFor, text, required, title }: { htmlFor: string; text: string; required?: boolean; title?: string }) {
  return (
    <label htmlFor={htmlFor} className={styles.label} title={title}>
      {text}{required && <span className={styles.required} aria-hidden="true"> *</span>}
    </label>
  );
}
