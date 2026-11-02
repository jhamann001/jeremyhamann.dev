import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost";
  size?: "sm";
};

export function Button({ variant = "primary", size, className = "", type = "button", children, ...rest }: Props) {
  const cls = [styles.btn, styles[variant], size ? styles.sm : "", className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}
