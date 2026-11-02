import styles from "./Avatar.module.css";

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function Avatar({ name, gradient, size = 34 }: { name: string; gradient?: string; size?: number }) {
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, background: gradient ?? "var(--green)", fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}
