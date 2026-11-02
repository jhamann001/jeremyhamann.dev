import styles from "./EnvBanner.module.css";

// Thin, un-missable environment banner so nobody mistakes a non-prod instance
// for production. Renders ONLY when APP_ENV names a non-prod environment (the
// aoa-dev service sets APP_ENV=dev). Prod leaves it unset / "prod" → nothing
// renders. APP_ENV is a RUNTIME server env var (not NEXT_PUBLIC_*), read here in
// a server component, so it works even if the dev service reuses a prod-built
// image — no build-time inlining involved.
const LABELS: Record<string, string> = { dev: "DEV", staging: "STAGING" };

export function EnvBanner() {
  const env = (process.env.APP_ENV ?? "").toLowerCase();
  const label = LABELS[env];
  if (!label) return null;
  return (
    <div className={styles.banner} role="status" aria-label={`${label} environment — not production`}>
      {label} · not production
    </div>
  );
}
