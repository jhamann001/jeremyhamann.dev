import { createFeeSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";

export type FeeStoreFailure =
  | { ok: false; reason: "not_configured" }
  | { ok: false; reason: "invalid"; error: string }
  | { ok: false; reason: "upstream"; status: number; error?: string }
  | { ok: false; reason: "network" }
  | { ok: false; reason: "unreadable" };

export type FeeStoreSuccess = { ok: true; status: number; body: unknown };

function feeStoreSettings(): { apiKey: string; rowsUrl: string } | null {
  const apiKey = process.env.FEE_STORE_API_KEY;
  const dbUrl = process.env.FEE_STORE_DB_URL;
  const tableId = process.env.FEE_STORE_FEES_TABLE_ID;
  if (!apiKey || !dbUrl || !tableId) return null;
  return { apiKey, rowsUrl: `${dbUrl}/${tableId}/rows` };
}

export function feeStoreConfigured(): boolean {
  return feeStoreSettings() != null;
}

function headers(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function readBody(res: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false };
  }
}

export async function listFeeCreditRows(filter: {
  clientName?: string | null;
  accountNumber?: string | null;
}): Promise<FeeStoreSuccess | FeeStoreFailure> {
  const settings = feeStoreSettings();
  if (!settings) return { ok: false, reason: "not_configured" };
  const query = new URLSearchParams();
  const body: Record<string, string> = {};
  if (typeof filter.clientName === "string") body.client_name = filter.clientName;
  if (typeof filter.accountNumber === "string") body.account_numbers = filter.accountNumber;
  if (Object.keys(body).length > 0) query.set("filter", JSON.stringify(body));
  const url = query.toString() ? `${settings.rowsUrl}?${query}` : settings.rowsUrl;
  try {
    const res = await fetch(url, { method: "GET", headers: headers(settings.apiKey), cache: "no-store" });
    if (!res.ok) {
      logger.error({ status: res.status, reason: "upstream" }, "fee credit list failed");
      return { ok: false, reason: "upstream", status: res.status };
    }
    const parsed = await readBody(res);
    if (!parsed.ok) return { ok: false, reason: "unreadable" };
    return { ok: true, status: res.status, body: parsed.body };
  } catch {
    logger.error({ reason: "network" }, "fee credit list failed");
    return { ok: false, reason: "network" };
  }
}

export async function createFeeCreditRow(input: unknown): Promise<FeeStoreSuccess | FeeStoreFailure> {
  const settings = feeStoreSettings();
  if (!settings) return { ok: false, reason: "not_configured" };
  const parsed = createFeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", error: formatZodError(parsed.error) };
  const feeStoreRow = {
    client_name: parsed.data.clientName,
    client_user_id: parsed.data.clientUserId ?? null,
    fee_type: parsed.data.feeType ?? "ACAT Transfer Fee",
    fee_amount: parsed.data.feeAmount,
    account_numbers: parsed.data.accountNumber,
    waiver_reason: parsed.data.waiverReason ?? null,
    submission_date: new Date().toISOString(),
    status: "Pending",
    apex_request: parsed.data.apexRequest ?? null,
    user_role: parsed.data.userRole ?? null,
  };
  try {
    const res = await fetch(settings.rowsUrl, {
      method: "POST",
      headers: headers(settings.apiKey),
      body: JSON.stringify(feeStoreRow),
    });
    if (!res.ok) {
      logger.error({ status: res.status, reason: "upstream" }, "fee credit create failed");
      return { ok: false, reason: "upstream", status: res.status };
    }
    const body = await readBody(res);
    if (!body.ok) return { ok: false, reason: "unreadable" };
    return { ok: true, status: res.status, body: body.body };
  } catch {
    logger.error({ reason: "network" }, "fee credit create failed");
    return { ok: false, reason: "network" };
  }
}

export async function deleteFeeCreditRow(id: string): Promise<FeeStoreSuccess | FeeStoreFailure> {
  if (!id.trim()) return { ok: false, reason: "invalid", error: "missing id" };
  const settings = feeStoreSettings();
  if (!settings) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(`${settings.rowsUrl}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(settings.apiKey),
    });
    if (!res.ok) {
      logger.error({ status: res.status, reason: "upstream" }, "fee credit delete failed");
      return { ok: false, reason: "upstream", status: res.status };
    }
    return { ok: true, status: res.status, body: null };
  } catch {
    logger.error({ reason: "network" }, "fee credit delete failed");
    return { ok: false, reason: "network" };
  }
}
