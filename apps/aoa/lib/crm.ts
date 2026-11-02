import { demoMode } from "@/lib/demo/mode";

const DEFAULT_CRM_ORIGIN =
  "https://crm.example";

const SALESFORCE_TASK_ID = /^00T[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

function crmOrigin(configuredOrigin: string | undefined): string | null {
  const candidate = configuredOrigin?.trim() || DEFAULT_CRM_ORIGIN;

  try {
    const url = new URL(candidate);
    // The demo's CRM lives on the reserved .example domain (RFC 2606), which never resolves on the internet.
    const salesforceLightningHost =
      url.hostname.endsWith(".lightning.force.com") ||
      url.hostname.endsWith(".my.salesforce.com") ||
      /^[a-z0-9-]+\.example$/.test(url.hostname);

    // The configuration is an origin, not a path prefix. Failing closed here
    // prevents a malformed environment value from turning mirrored CRM data
    // into an arbitrary external link.
    if (
      url.protocol !== "https:" ||
      !salesforceLightningHost ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Return the canonical CRM/Salesforce Task record URL for a real Task ID.
 *
 * The optional `ws` account context in a copied Lightning URL is intentionally
 * omitted: mirror.task does not expose the exact parent account URL needed to
 * construct it safely, and the canonical Task path opens the same record.
 */
export function crmTaskUrl(
  taskId: string | null | undefined,
  configuredOrigin = process.env.NEXT_PUBLIC_CRM_ORIGIN,
): string | null {
  const id = taskId?.trim();
  if (!id || !SALESFORCE_TASK_ID.test(id)) return null;
  // The public demo has no CRM to open: its tasks stay in AOA.
  if (demoMode()) return null;

  const origin = crmOrigin(configuredOrigin);
  if (!origin) return null;

  return `${origin}/lightning/r/Task/${id}/view`;
}
