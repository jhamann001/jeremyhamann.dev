import type { JobDefinition, JobEnvironment } from "@/lib/data-jobs/contracts";

/**
 * Reviewed identities only. Enabled state, schedules and results must come from
 * live provider observations, never this inventory. Evidence and known gaps:
 * docs/operations/data-jobs-inventory-2026-09-18.md.
 */
export const DATA_JOB_PROVIDER_CONFIG = {
  dev: {
    n8nOrigin: "https://n8n-dev.example",
    aoaOrigin: "https://aoa-dev.example",
    gcpProject: "ops-portal-dev",
    region: "us-central1",
  },
  prod: {
    n8nOrigin: "https://n8n.example.com",
    aoaOrigin: "https://aoa.jeremyhamann.dev",
    gcpProject: "ops-portal",
    region: "us-central1",
  },
} as const;

export const DATA_JOB_N8N_ORIGINS = [
  DATA_JOB_PROVIDER_CONFIG.dev.n8nOrigin,
  DATA_JOB_PROVIDER_CONFIG.prod.n8nOrigin,
] as const;

// Initial detector policy, not a provider timeout or service-level commitment.
// Owner-approved tuning can narrow these after complete run evidence exists.
const DEFAULT_GRACE_SECONDS = 15 * 60;
const DEFAULT_MAX_RUN_SECONDS = 30 * 60;
const OWNER_UNASSIGNED = "Operations — owner not assigned";
const REPOSITORY = "https://github.com/cedar-ridge-wealth/Always-On-Advice";

type N8nDefinition = {
  key: string;
  name: string;
  source: string;
  prodId: string;
  devId?: string;
  trigger: string;
  destination: string;
  consumers: readonly string[];
  runbook?: string;
  prodEnabled?: boolean;
  devEnabled?: boolean;
};

const N8N_JOBS: readonly N8nDefinition[] = [
  {
    key: "crm-clients", name: "CRM client import",
    source: "CRM / Salesforce", prodId: "AZ5vkPjglVp7uI3q", devId: "AZ5vkPjglVp7uI3q",
    trigger: "Published n8n schedule; source Contacts read",
    destination: "/api/ingest/clients → client mirror → CRM identity / relationships",
    consumers: ["Clients", "Households", "CRM Explorer"],
    runbook: "docs/operations/crm-identity-reconciliation.md",
  },
  {
    key: "crm-activity", name: "CRM activity import",
    source: "CRM / Salesforce", prodId: "uRFuBiNu1BgHsEED", devId: "q272WinW57LKNOmI",
    trigger: "Published n8n schedule; Salesforce Call activities read",
    destination: "/api/ingest/activity → mirror.activity",
    consumers: ["Client communications", "Household activity"],
  },
  {
    key: "crm-emails", name: "CRM email import",
    source: "CRM / Salesforce", prodId: "vrSnueIt3BQxvzZN", devId: "LbPBsd1D8lUg3gm3",
    trigger: "Published n8n schedule; Salesforce Email activities read",
    destination: "/api/ingest/emails → mirror.email",
    consumers: ["Client communications", "Household communications"],
  },
  {
    key: "crm-tasks", name: "CRM task import",
    source: "CRM / Salesforce", prodId: "kzzOExA7ylBUhcbQ", devId: "fHKZnQWdtpZglWBC",
    trigger: "Published n8n schedule; Salesforce Tasks read",
    destination: "/api/ingest/tasks → mirror.task",
    consumers: ["Tasks", "Client activity"],
  },
  {
    key: "crm-deals", name: "CRM deal report import",
    source: "CRM / Salesforce", prodId: "cDKxeZiFVK8PEQMc", devId: "cDKxeZiFVK8PEQMc",
    trigger: "Published n8n schedule → Gmail report attachment → Drive",
    destination: "/api/ingest/deals → deals → CRM identity / relationships",
    consumers: ["Deals", "Asset Transfers", "CRM Explorer"],
    runbook: "docs/operations/crm-identity-reconciliation.md",
  },
  {
    key: "crm-parents", name: "CRM parent Account / Contact import",
    source: "CRM / Salesforce", prodId: "jyCSIeeBbqoNN5n7",
    trigger: "Published n8n schedule or owner-approved manual canary",
    destination: "/api/ingest/crm-parents → CRM parent registry",
    consumers: ["CRM Explorer", "Confirmed relationships"],
    runbook: "docs/operations/crm-identity-reconciliation.md",
  },
  {
    key: "crm-reconciliation", name: "CRM identity and relationship reconciliation",
    source: "AOA CRM", prodId: "tjeLnRYrbm4pX9jO", devId: "AedaAroSenJaKQRN",
    trigger: "Published n8n schedule → AOA identity → relationships → coverage check",
    destination: "/api/cron/crm-identity + /api/cron/crm-relationships → CRM registry",
    consumers: ["CRM Explorer", "Client relationships", "Record CRM IDs"],
    runbook: "docs/operations/crm-relationship-reconciliation.md",
  },
  {
    key: "treasury-rate", name: "Treasury risk-free rate import",
    source: "U.S. Treasury", prodId: "XuOTcuSf6J85f0yo", devId: "XuOTcuSf6J85f0yo",
    trigger: "Published n8n schedule → Treasury daily-yield CSVs",
    destination: "/api/ingest/risk-free-rate → mirror.risk_free_rate",
    consumers: ["Performance calculations"],
    runbook: "docs/operations/treasury-rate-freshness.md",
  },
  {
    key: "appointments-feed", name: "Appointments Feed import",
    source: "Advisory Slack digest", prodId: "JGNn1x2b8wNAFEGX", devId: "JGNn1x2b8wNAFEGX",
    trigger: "Published n8n schedule → Slack digest read; upstream digest producer unverified",
    destination: "/api/ingest/appointments → mirror.appointment",
    consumers: ["Command Center meetings"],
  },
  {
    key: "zendesk-tickets", name: "Zendesk daily ticket import",
    source: "zendesk", prodId: "ZORdwjp6NTmRQlIe", devId: "ZORdwjp6NTmRQlIe", devEnabled: false,
    trigger: "Published n8n schedule or manual linkage test → tickets / public comments",
    destination: "/api/ingest/zendesk-tickets → ticket / public-comment mirror",
    consumers: ["Household support context", "Client communications"],
    runbook: "docs/operations/zendesk-ticket-sync.md",
  },
  {
    key: "zendesk-backfill", name: "Zendesk historical backfill (manual)",
    source: "zendesk", prodId: "Xhx6bd856Yxvy1Oj", devId: "Xhx6bd856Yxvy1Oj",
    prodEnabled: false, devEnabled: false,
    trigger: "Owner-approved manual backfill; no recurring activation",
    destination: "/api/ingest/zendesk-tickets → historical ticket mirror",
    consumers: ["Household support context", "Client communications"],
    runbook: "docs/operations/zendesk-ticket-sync.md",
  },
  {
    key: "schwab-balances", name: "Schwab account balance import",
    source: "Schwab", prodId: "iB88JrMECF1A8jU7", devId: "iB88JrMECF1A8jU7", devEnabled: false,
    trigger: "Published n8n schedule or manual run → S3 file → calendar / snapshot validation",
    destination: "/api/ingest/schwab-account-balances → account balance snapshot",
    consumers: ["Schwab account balances", "Account displays"],
    runbook: "docs/planning/schwab-account-balance-ingest.md",
  },
  {
    key: "transfer-closeout", name: "Transfer closeout callback",
    source: "AOA / Slack", prodId: "vHvUvt61Thgciojx", devId: "vHvUvt61Thgciojx",
    trigger: "AOA closeout webhook → Slack checklist; Slack interaction webhook → callback",
    destination: "/api/ingest/slack-checklist → transfer closeout state",
    consumers: ["Asset Transfer checklist"],
  },
];

type SchedulerDefinition = {
  key: string;
  providerId: string;
  name: string;
  source: string;
  trigger: string;
  destination: string;
  consumers: readonly string[];
  runbook?: string;
};

// Only production resources were enumerated successfully. Do not fabricate dev
// jobs from Terraform examples or mark a blocked provider listing as empty.
const PRODUCTION_SCHEDULER_JOBS: readonly SchedulerDefinition[] = [
  {
    key: "account-aum", providerId: "aoa-account-aum-daily", name: "Account AUM snapshot import",
    source: "Apex / Warehouse", trigger: "Cloud Scheduler → AOA → Warehouse card 6601",
    destination: "/api/cron/account-aum → mirror.client_account_aum",
    consumers: ["Account balances", "Household AUM", "Reports"],
    runbook: "docs/operations/account-aum-freshness.md",
  },
  {
    key: "account-aum-stale-only", providerId: "aoa-account-aum-retry", name: "Account AUM stale-only scheduled retry",
    source: "Apex / Warehouse", trigger: "Separate Cloud Scheduler job → freshness precheck → source read only if stale",
    destination: "/api/cron/account-aum?onlyIfStale=1 → mirror.client_account_aum",
    consumers: ["Account balances", "Household AUM", "Reports"],
    runbook: "docs/operations/account-aum-freshness.md",
  },
  {
    key: "account-aum-health", providerId: "aoa-account-aum-health-weekdays", name: "Account AUM freshness monitor",
    source: "Apex / Warehouse", trigger: "Cloud Scheduler → AOA freshness check (monitor, not import)",
    destination: "/api/cron/health/aum-freshness → source-health evidence",
    consumers: ["Data Health"], runbook: "docs/operations/account-aum-freshness.md",
  },
  {
    key: "asset-map", providerId: "aoa-asset-map-hourly", name: "Asset Map import",
    source: "ACAT statement pipeline", trigger: "Cloud Scheduler → AOA → statement-pipeline household / account / position API",
    destination: "/api/cron/asset-map → mirror.acat_asset_map_*",
    consumers: ["Asset Transfer mapping"],
  },
  {
    key: "transfer-sync", providerId: "aoa-transfer-sync-hourly", name: "Deal-to-transfer reconciliation",
    source: "AOA deals", trigger: "Cloud Scheduler → AOA reconciler → existing deal records",
    destination: "/api/cron/transfer-sync → deal-owned transfer fields",
    consumers: ["Asset Transfer cards"],
  },
  {
    key: "review-queue", providerId: "aoa-review-queue", name: "Trade Request and CRM review scan",
    source: "Trade Request / AOA CRM", trigger: "Cloud Scheduler → AOA bounded sweep → Trade Request and CRM reads",
    destination: "/api/cron/review-queue → review items / combined sweep checkpoint",
    consumers: ["Review Queue", "Trade Request health"],
    runbook: "docs/operations/data-health.md",
  },
  {
    key: "operations-slack", providerId: "aoa-operations-slack", name: "Operations Slack delivery",
    source: "AOA Operations outbox", trigger: "Cloud Scheduler → AOA notification dispatcher (outbound, not import)",
    destination: "/api/cron/operations-slack → Slack / delivery ledger",
    consumers: ["Operations submission notifications"],
    runbook: "docs/planning/operations-slack-notifications.md",
  },
];

function runbookUrl(environment: JobEnvironment, path: string | undefined): string | undefined {
  if (!path) return undefined;
  return `${REPOSITORY}/blob/${environment === "prod" ? "main" : "dev"}/${path}`;
}

/** Returns fresh metadata objects so callers cannot mutate the reviewed registry. */
export function getDataJobs(environment: JobEnvironment): JobDefinition[] {
  const config = DATA_JOB_PROVIDER_CONFIG[environment];
  const n8n: JobDefinition[] = N8N_JOBS.flatMap((job) => {
    const providerId = environment === "prod" ? job.prodId : job.devId;
    if (!providerId) return [];
    return [{
      id: `${environment}-${job.key}`,
      name: job.name,
      source: job.source,
      environment,
      provider: "n8n" as const,
      providerId,
      trigger: job.trigger,
      runner: `n8n ${environment} → AOA Cloud Run ${environment}`,
      destination: job.destination,
      consumers: [...job.consumers],
      owner: OWNER_UNASSIGNED,
      jobUrl: `${config.n8nOrigin}/workflow/${providerId}`,
      runbookUrl: runbookUrl(environment, job.runbook),
      expectedEnabled: (environment === "prod" ? job.prodEnabled : job.devEnabled) ?? true,
      graceSeconds: DEFAULT_GRACE_SECONDS,
      maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
    }];
  });
  if (environment === "dev") return n8n;
  return [...n8n, ...PRODUCTION_SCHEDULER_JOBS.map((job): JobDefinition => ({
    id: `${environment}-${job.key}`,
    name: job.name,
    source: job.source,
    environment,
    provider: "cloud-scheduler",
    providerId: `projects/${config.gcpProject}/locations/${config.region}/jobs/${job.providerId}`,
    trigger: job.trigger,
    runner: `Cloud Scheduler → AOA Cloud Run (${config.gcpProject} / ${config.region})`,
    destination: job.destination,
    consumers: [...job.consumers],
    owner: OWNER_UNASSIGNED,
    jobUrl: `https://console.cloud.google.com/cloudscheduler/jobs/edit/${config.region}/${job.providerId}?project=${config.gcpProject}`,
    runbookUrl: runbookUrl(environment, job.runbook),
    expectedEnabled: true,
    graceSeconds: DEFAULT_GRACE_SECONDS,
    maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
  }))];
}
