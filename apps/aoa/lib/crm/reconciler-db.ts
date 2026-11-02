import { PrismaClient } from "@prisma/client";

// The CRM reconciler is a third, deliberately separate database principal. It
// never falls back to DATABASE_URL: missing configuration must fail closed
// rather than accidentally running machine-wide reads/writes as app_rw.
//
// This client is lazy because dark deployments do not mount its credential, but
// once configured it must be a process-wide singleton in every environment.
// Cloud Run reuses one Node process across requests; constructing a PrismaClient
// per CRM sweep leaves another pool alive and eventually exhausts Cloud SQL.
const globalForCrmReconciler = globalThis as unknown as {
  crmReconcilerPrisma?: PrismaClient;
  crmReconcilerUrl?: string;
};

const CONNECTION_LIMIT = 1;

function boundedReconcilerUrl(): string {
  const url = process.env.CRM_RECONCILER_DATABASE_URL;
  if (!url) throw new Error("crm_reconciler_not_configured");
  if (url.includes("connection_limit")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}connection_limit=${CONNECTION_LIMIT}`;
}

export function crmReconcilerClient(): PrismaClient {
  const url = boundedReconcilerUrl();
  if (
    globalForCrmReconciler.crmReconcilerPrisma
    && globalForCrmReconciler.crmReconcilerUrl === url
  ) {
    return globalForCrmReconciler.crmReconcilerPrisma;
  }

  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    datasources: { db: { url } },
  });

  globalForCrmReconciler.crmReconcilerPrisma = client;
  globalForCrmReconciler.crmReconcilerUrl = url;
  return client;
}
