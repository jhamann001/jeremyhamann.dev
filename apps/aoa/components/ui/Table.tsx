import type {
  HTMLAttributes,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from "react";
import styles from "./Table.module.css";

export function Table({ className = "", children, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table className={`${styles.table} ${className}`.trim()} {...rest}>
      {children}
    </table>
  );
}
export function THead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}
export function TBody({ className = "", ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={`${styles.tbody} ${className}`.trim()} {...rest} />;
}
export function TR(props: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} />;
}
export function TH({ className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={`${styles.th} ${className}`.trim()} {...rest} />;
}
export function TD({ className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`${styles.td} ${className}`.trim()} {...rest} />;
}
