import crypto from "crypto";
import { demoMode } from "@/lib/demo/mode";

// Outbound webhook to n8n on entry into IN_TRANSFER (SLACK_TRANSFER_CLOSEOUT).
// Fired POST-COMMIT and fire-and-forget (ADR-4): a failure here must NEVER roll
// back the stage move, so this NEVER throws — it logs a static, PII-free line and
// returns. Env is read AT CALL TIME (tests toggle it; prod resolves at start).
// Trust is a shared secret: the body is signed HMAC-SHA256 → `x-aoa-signature`,
// which the n8n webhook verifies before acting.

export type CloseoutTransfer = {
  id: string;
  client_name: string;
  household_name: string | null;
  amount: number;
  owner_kind: string;
  owner_name: string | null;
};

export type CloseoutWebhookInput = {
  transfer: CloseoutTransfer;
  // Mirrors SlackCloseoutItem: `group`/`note` are display-only hints n8n needs
  // for the grouped Slack render (JSON.stringify drops them when absent).
  checklist: {
    item_key: string;
    label: string;
    sort: number;
    group?: string;
    note?: string;
  }[];
  /** The public demo only: the transfer's household and client, so its Outbox shows the capture to the personas who
   *  can see them. Never sent to n8n. */
  about?: { householdSfId: string | null; clientSfId: string | null };
};

export async function postCloseoutWebhook(
  input: CloseoutWebhookInput,
): Promise<void> {
  if (demoMode()) return captureInDemo(input);
  const url = process.env.N8N_CLOSEOUT_WEBHOOK_URL;
  if (!url) {
    // Not a failure — the feature can be flag-on with the webhook not yet wired
    // (e.g. before Slice 2 / prod secrets). Log once, no throw.
    console.warn(
      "[slack-closeout] N8N_CLOSEOUT_WEBHOOK_URL not set — skipping webhook",
    );
    return;
  }
  const secret = process.env.SLACK_CLOSEOUT_WEBHOOK_SECRET ?? "";
  if (!secret) {
    // Not fatal (n8n is the verifier and fails closed on a bad signature), but a
    // misconfig worth surfacing — an unsigned-in-effect webhook. No values logged.
    console.warn(
      "[slack-closeout] SLACK_CLOSEOUT_WEBHOOK_SECRET not set — signature will not authenticate",
    );
  }
  const base = (process.env.AUTH_URL ?? "").replace(/\/$/, "");

  const body = JSON.stringify({
    event: "transfer.in_transfer",
    transfer: input.transfer,
    checklist: input.checklist,
    callback_url: `${base}/api/ingest/slack-checklist`,
  });
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aoa-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Status only — never the response body (could echo input) or the URL.
      console.error(`[slack-closeout] webhook non-2xx status=${res.status}`);
    }
  } catch (e) {
    // Error NAME only (e.g. "TimeoutError"/"TypeError") — never the message/URL.
    console.error(
      `[slack-closeout] webhook post failed err=${e instanceof Error ? e.name : "unknown"}`,
    );
  }
}

// The public demo has no n8n: the checklist it would turn into a Slack post goes to the Outbox. Same contract as
// the webhook: never throws.
async function captureInDemo(input: CloseoutWebhookInput): Promise<void> {
  const { transfer, checklist } = input;
  const amount = transfer.amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  try {
    const [{ prisma }, { recordOutbox }] = await Promise.all([import("@/lib/db"), import("@/lib/demo/outbox")]);
    await recordOutbox(prisma, {
      channel: "Slack",
      destination: "#transfers (via n8n)",
      title: `Closeout checklist sent for the ${transfer.household_name ?? transfer.client_name} transfer`,
      detail: [transfer.client_name, amount, `${checklist.length} checklist items`, transfer.owner_name]
        .filter(Boolean).join(" · "),
      body: JSON.stringify({ event: "transfer.in_transfer", transfer, checklist }, null, 2),
      about: input.about,
    });
  } catch (e) {
    console.error(`[slack-closeout] outbox write failed err=${e instanceof Error ? e.name : "unknown"}`);
  }
}
