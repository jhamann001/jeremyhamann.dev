/**
 * The capability catalog for `/admin/flags`.
 *
 * PURE DATA. Nothing here imports `@/lib/env` — a client file may not, and more to the point
 * this module must not be able to read a value even by accident. It lists the env variable NAMES a
 * capability depends on and what the desk loses while they are unset; whether they are set is
 * resolved server-side in the page and passed in as booleans.
 *
 * WHY THE PAGE IS READ-ONLY, and why that is not a limitation to be fixed later. Every switch in
 * this app is an environment variable resolved at boot and validated by key name — "config is code"
 * (#73). A runtime toggle would be a second source of truth that no deploy, no
 * Terraform plan and no PR diff would show, and the first question after an incident is "what was
 * switched on at the time". The ledger answers that today because the answer is in the revision.
 * So this screen tells an administrator what state the deployment is in, and changing it stays a
 * deploy.
 *
 * WHAT IS NEVER RENDERED: a value, a prefix, a length, or a masked form of any of them. A masked
 * secret is still a length and a first character, and several of these keys are credentials in a
 * URL (`SLA_ALERT_SLACK_WEBHOOK_URL`) or JSON maps of staff identities (`SLACK_USER_MAP`). Set or
 * unset is the whole of what this page knows.
 */

/** How the list is grouped. Ordered as the page renders the sections. */
export const FLAG_AREAS = ["Outbound", "Intake", "Automation", "Integrations", "Storage"] as const;
export type FlagArea = (typeof FLAG_AREAS)[number];

export type FlagSpec = {
  /** Stable id — used for React keys and `data-flag`, never shown as a value. */
  id: string;
  label: string;
  area: FlagArea;
  /**
   * The env variable NAMES this capability reads. More than one means all-or-nothing: the capability
   * is on only when every one of them is set, which is exactly how `src/lib/env.ts` validates them.
   */
  envKeys: readonly string[];
  /** What is switched off while this is false. Written for somebody who has to decide whether to care. */
  effect: string;
  /** What happens INSTEAD while it is off — the fallback, so "off" never reads as "broken". */
  whileOff: string;
};

export const FLAG_CATALOG: readonly FlagSpec[] = [
  // --- Outbound ----------------------------------------------------------------------------
  {
    id: "auto-acknowledgement",
    label: "Auto-acknowledgement to the requester",
    area: "Outbound",
    envKeys: ["AUTO_ACK_ENABLED"],
    effect: "A SYSTEM reply confirming the desk has the request is written and queued when a ticket arrives.",
    whileOff: "No automatic message is written or queued. The first reply a client gets is one a person wrote.",
  },
  {
    id: "resolved-notice",
    label: "Resolved notice to the requester",
    area: "Outbound",
    envKeys: ["RESOLVED_NOTICE_ENABLED"],
    effect: "A SYSTEM reply is written and queued when a ticket reaches RESOLVED.",
    whileOff: "Nothing is sent when a ticket is resolved.",
  },
  {
    id: "reply-threading",
    label: "Reply-token threading on outbound mail",
    area: "Outbound",
    envKeys: ["REPLY_TOKEN_SECRET"],
    effect: "Outbound replies carry a signed token so a client's reply lands back on the same ticket.",
    whileOff: "Replies are matched on headers alone, and an unmatched reply is held for a human to place.",
  },
  {
    id: "deep-links",
    label: "Absolute deep links in out-of-band text",
    area: "Outbound",
    envKeys: ["APP_BASE_URL"],
    effect: "Slack lines and notifications link to a full https URL.",
    whileOff: "Links degrade to bare paths, which still route for anyone who already has the app open.",
  },
  // --- Intake ------------------------------------------------------------------------------
  {
    id: "mailbox-routing",
    label: "Inbound mailbox routing",
    area: "Intake",
    envKeys: ["MAILBOX_MAP"],
    effect: "Each inbound address maps to a queue, a brand and optionally a category.",
    whileOff: "Every mailbox is unknown, so inbound mail is held for a reviewer rather than routed.",
  },
  {
    id: "sender-auth",
    label: "Trusted sender-authentication hosts",
    area: "Intake",
    envKeys: ["EMAIL_TRUSTED_AUTHSERV_IDS"],
    effect: "Names the receiving hosts whose SPF/DKIM/DMARC verdict the desk will act on.",
    whileOff: "The module default applies. An empty list is NOT the same as unset and would hold every message.",
  },
  {
    id: "requester-domain-guard",
    label: "Requester domain guard (non-production)",
    area: "Intake",
    envKeys: ["ALLOWED_REQUESTER_DOMAINS"],
    effect: "Refuses a requester address outside the listed domains, so a dev instance cannot mail a real client.",
    whileOff: "No domain guard. This is the intended PRODUCTION state — the guard is a dev and local safeguard.",
  },
  // --- Automation --------------------------------------------------------------------------
  {
    id: "auto-close",
    label: "Auto-close of resolved tickets",
    area: "Automation",
    envKeys: ["AUTO_CLOSE_DAYS"],
    effect: "The auto-close job closes a RESOLVED ticket after this many days of silence.",
    whileOff: "The job logs 'disabled' and exits 0. Nothing closes itself; a resolved ticket stays resolved.",
  },
  {
    id: "digest-hour",
    label: "Daily digest hour",
    area: "Automation",
    envKeys: ["DIGEST_HOUR_LOCAL"],
    effect: "The hour of the firm day (America/New_York) the digest job posts.",
    whileOff: "08:00 firm time. Unset is a default hour, not a disabled digest.",
  },
  {
    id: "sla-digest",
    label: "SLA sweep digest to Slack",
    area: "Automation",
    envKeys: ["SLA_ALERT_SLACK_WEBHOOK_URL"],
    effect: "The five-minute sweep posts one PII-light digest of new warnings and breaches.",
    whileOff: "The sweep still runs, still dedupes and still writes SLA_ALERT rows. It posts nothing.",
  },
  {
    id: "queue-event-alerts",
    label: "Per-queue event alerts to Slack",
    area: "Automation",
    envKeys: ["SLACK_QUEUE_WEBHOOKS"],
    effect: "Assignments, hand-offs and reopens are announced in each queue's own channel.",
    whileOff: "The job runs, reads and advances its cursor, and posts nothing.",
  },
  {
    id: "slack-dm",
    label: "Slack direct messages for notifications",
    area: "Automation",
    envKeys: ["SLACK_USER_MAP"],
    effect: "Maps a staff email to a Slack member id so a notification can also arrive as a DM.",
    whileOff: "No Slack DM is ever attempted. The in-app inbox is the only channel.",
  },
  {
    id: "web-push",
    label: "Web push notifications",
    area: "Automation",
    envKeys: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
    effect: "Browsers can subscribe and receive push notifications from the desk.",
    whileOff: "The subscribe route answers 404, the opt-in control renders nothing, and sending returns 'disabled'.",
  },
  // --- Integrations ------------------------------------------------------------------------
  {
    id: "ai-drafting",
    label: "AI reply drafting",
    area: "Integrations",
    envKeys: ["AI_DRAFTING_PROVIDER", "VERTEX_PROJECT", "VERTEX_LOCATION", "VERTEX_MODEL"],
    effect: "The composer can ask the configured model for a draft. It never auto-sends; a person edits and submits.",
    whileOff: "The draft seam is off and the button is hidden.",
  },
  {
    id: "webhooks",
    label: "Outbound event webhooks",
    area: "Integrations",
    envKeys: ["WEBHOOKS_ENABLED"],
    effect: "The dispatcher signs and delivers events to the configured endpoints.",
    whileOff: "Endpoints can be configured and nothing is sent. Deliveries are not queued either.",
  },
  {
    id: "mcp",
    label: "MCP surface for agents",
    area: "Integrations",
    envKeys: ["MCP_ENABLED"],
    effect: "POST /api/mcp serves the tool registry to a token-bearing agent runtime.",
    whileOff: "The route answers 404 to everyone, bearer token or not.",
  },
  // --- Storage -----------------------------------------------------------------------------
  {
    id: "attachments-bucket",
    label: "Attachment storage in GCS",
    area: "Storage",
    envKeys: ["ATTACHMENTS_BUCKET"],
    effect: "Attachments are stored in the named bucket and served through signed URLs.",
    whileOff: "The local filesystem backend is used. Correct for local development, never for production.",
  },
  {
    id: "duplicate-copy",
    label: "Nightly duplicate copy to retention-locked storage",
    area: "Storage",
    envKeys: ["DUPLICATE_COPY_BUCKET"],
    effect: "The nightly job writes a second copy of the ledger to a retention-locked bucket.",
    whileOff: "The job logs and exits. There is no second copy.",
  },
];

/** One row as the page renders it: the contract's `EnvCapabilityDTO` plus what the list needs. */
export type FlagRow = {
  /** The primary env key NAME. Never a value. */
  key: string;
  label: string;
  enabled: boolean;
  effect: string;
  area: FlagArea;
  id: string;
  envKeys: readonly string[];
  whileOff: string;
  /**
   * True when this capability reads several keys and only SOME of them are set. `src/lib/env.ts`
   * refuses that at boot, so seeing it here means the process was started before the group check, or
   * the presence map was built by hand and is wrong — either way it is worth showing rather than
   * rounding down to "off".
   */
  partiallyConfigured: boolean;
};

/**
 * The catalog against a presence map (env key NAME → is it set). A key absent from the map counts as
 * unset: fail-closed, the same rule every one of these variables follows.
 */
export function toFlagRows(
  specs: readonly FlagSpec[],
  present: Readonly<Record<string, boolean>>,
): FlagRow[] {
  return specs.map((spec) => {
    const setCount = spec.envKeys.filter((k) => present[k] === true).length;
    return {
      key: spec.envKeys[0],
      label: spec.label,
      enabled: setCount === spec.envKeys.length,
      effect: spec.effect,
      area: spec.area,
      id: spec.id,
      envKeys: spec.envKeys,
      whileOff: spec.whileOff,
      partiallyConfigured: setCount > 0 && setCount < spec.envKeys.length,
    };
  });
}

/** Rows grouped into the page's sections, in `FLAG_AREAS` order, skipping an area with no rows. */
export function groupByArea(rows: readonly FlagRow[]): Array<{ area: FlagArea; rows: FlagRow[] }> {
  return FLAG_AREAS.map((area) => ({ area, rows: rows.filter((r) => r.area === area) })).filter(
    (g) => g.rows.length > 0,
  );
}
