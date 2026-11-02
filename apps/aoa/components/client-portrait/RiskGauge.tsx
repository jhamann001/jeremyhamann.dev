import { StatTile } from "@/components/ui";
import type { RiskProfile } from "@/lib/data/types";
import styles from "./RiskGauge.module.css";

// Circular risk gauge (mock via the B0 seam). Score is out of 25 (mockup scale).
// Pure SVG render → server component. Colors come from tokens via a CSS class on
// the progress arc so both themes work without inline hex.

const MAX = 25;
const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function RiskGauge({ risk }: { risk: RiskProfile }) {
  const clamped = Math.max(0, Math.min(MAX, risk.score));
  const fraction = clamped / MAX;
  const dashOffset = CIRCUMFERENCE * (1 - fraction);

  return (
    <div className={styles.wrap}>
      <div className={styles.gaugeCol}>
        <svg
          className={styles.svg}
          viewBox="0 0 100 100"
          role="img"
          aria-label={`Risk score ${risk.score} of ${MAX}`}
        >
          <circle className={styles.track} cx="50" cy="50" r={RADIUS} />
          <circle
            className={styles.progress}
            cx="50"
            cy="50"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 50 50)"
          />
          <text className={styles.score} x="50" y="48" textAnchor="middle">
            {risk.score}
          </text>
          <text className={styles.of} x="50" y="63" textAnchor="middle">
            of {MAX}
          </text>
        </svg>
      </div>
      <div className={styles.stats}>
        <StatTile label="Tolerance" value={risk.tolerance} />
        <StatTile label="Capacity" value={risk.capacity} />
        <StatTile label="Change" value={risk.change} />
      </div>
    </div>
  );
}
