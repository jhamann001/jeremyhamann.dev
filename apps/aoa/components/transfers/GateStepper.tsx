import type { GateStatus } from "@/lib/data/transfer-basis";
import styles from "./GateStepper.module.css";

// Lifecycle gate stepper (WO ticket, TDD §6 / ADR-2) — done ✓ / now / todo
// with each stage's gate caption and, on the current stage, whether the
// structured data satisfies its gate. Presentational and server-safe (no
// hooks): the detail page computes `gateStatus(...)` and hands it in. Gates
// are SOFT — an unmet gate renders an amber advisory tag, never a lock.

export function GateStepper({ gates }: { gates: GateStatus[] }) {
  return (
    <ol className={styles.stepper} aria-label="Lifecycle gates">
      {gates.map((g) => (
        <li key={g.stage} className={`${styles.step} ${styles[g.state]}`}>
          <span className={styles.marker} aria-hidden="true">
            {g.state === "done" ? "✓" : g.state === "now" ? "●" : "○"}
          </span>
          <span className={styles.text}>
            <span className={styles.label}>
              {g.label}
              {g.state === "now" && (
                <span
                  className={g.satisfied ? styles.gateMet : styles.gateUnmet}
                >
                  {g.satisfied ? "gate met" : "gate not met"}
                </span>
              )}
            </span>
            <span className={styles.gate}>gate: {g.gate}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
