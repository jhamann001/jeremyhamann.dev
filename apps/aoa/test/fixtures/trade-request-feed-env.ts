import { vi } from "vitest";

// Every variable the ported feeds (lib/trade-requests/sources, ticket) and their cloud clients read. Tests that
// run native reads blank them so a developer shell can never configure Warehouse, Meridian, S3 or GCS and pull
// real data into a local run.
export const FEED_ENV = [
  "WAREHOUSE_URL", "WAREHOUSE_API_KEY", "WAREHOUSE_CONTACTS_QUESTION_ID", "WAREHOUSE_INVESTMENTS_QUESTION_ID",
  "WAREHOUSE_BALANCES_QUESTION_ID", "WAREHOUSE_STOCK_RECORD_QUESTION_ID", "WAREHOUSE_COST_BASIS_DB_ID", "WAREHOUSE_COST_BASIS_DB_IDS",
  "MERIDIAN_SNAPSHOT_SOURCE", "MERIDIAN_SNAPSHOT_BUCKET", "MERIDIAN_SNAPSHOT_FILE", "MERIDIAN_SNAPSHOT_S3_BUCKET",
  "MERIDIAN_SNAPSHOT_S3_REGION", "MERIDIAN_SNAPSHOT_S3_PREFIX", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

export function blankFeedEnv(): void {
  for (const name of FEED_ENV) vi.stubEnv(name, "");
}
