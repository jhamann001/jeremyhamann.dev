import { demoMode, portfolioLink } from "@/lib/demo/mode";
import styles from "./DemoBanner.module.css";

/** The band's fixed height. The full-height app shell and sign-in screen subtract it (--demo-banner-height). */
export const DEMO_BANNER_HEIGHT = "28px";

// The public demo's band across the top of every page, the sign-in page included: what this is, and the way back
// to the portfolio site it's shown from. One line at every width (shorter wording on phones). Renders nothing outside
// the demo.
export function DemoBanner() {
  if (!demoMode()) return null;
  const link = portfolioLink();
  return (
    <div className={styles.banner} role="note">
      <span className={styles.long}>Portfolio demo · every person, account and record is invented · resets nightly</span>
      <span className={styles.short}>Demo · invented data</span>
      {link && (
        <a href={link.url} aria-label={`Back to ${link.site}`}>
          <span className={styles.long}>Back to {link.site}</span>
          <span className={styles.short}>← {link.site}</span>
        </a>
      )}
    </div>
  );
}
