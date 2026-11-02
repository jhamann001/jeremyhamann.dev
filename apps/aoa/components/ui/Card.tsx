import type { HTMLAttributes } from "react";
import styles from "./Card.module.css";

type DivProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className = "", children, ...rest }: DivProps) {
  return (
    <div className={`${styles.card} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children, ...rest }: DivProps) {
  return (
    <div className={`${styles.header} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

export function CardBody({ className = "", children, ...rest }: DivProps) {
  return (
    <div className={`${styles.body} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
