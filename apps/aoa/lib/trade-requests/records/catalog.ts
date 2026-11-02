export type RecordKind = {
  table: string;
  key: readonly string[];
  /** Ignored by verification and never overwritten on copy-back: written only by sign-in on the standalone side. */
  standaloneOnly: readonly string[];
  /** Never delete standalone rows of this kind on copy-back (standalone sign-in and MCP token tables reference them). */
  neverDeleteOnCopyBack?: boolean;
};

/** Parent-before-child order; deletes run in reverse. Keys checked against the generated DDL by the parity test. */
export const RECORD_KINDS: readonly RecordKind[] = [
  { table: "users", key: ["id"], standaloneOnly: ["last_login", "google_id", "picture"], neverDeleteOnCopyBack: true },
  { table: "clients", key: ["id"], standaloneOnly: [] },
  { table: "accounts", key: ["id"], standaloneOnly: [] },
  { table: "trade_requests", key: ["id"], standaloneOnly: [] },
  { table: "audit_logs", key: ["id"], standaloneOnly: [] },
  { table: "notifications", key: ["id"], standaloneOnly: [] },
  { table: "client_exclusions", key: ["id"], standaloneOnly: [] },
  { table: "account_exclusions", key: ["id"], standaloneOnly: [] },
  { table: "digest_runs", key: ["run_date"], standaloneOnly: [] },
  { table: "registry_drift_runs", key: ["id"], standaloneOnly: [] },
  { table: "position_drift_accounts", key: ["id"], standaloneOnly: [] },
  { table: "drift_alert_sends", key: ["run_date_local"], standaloneOnly: [] },
  { table: "drift_status_overrides", key: ["account_id"], standaloneOnly: [] },
  { table: "security_sector", key: ["ticker"], standaloneOnly: [] },
] as const;
