import type { Prisma } from "@prisma/client";
import type { Identity } from "@/lib/rls";
import { writeAudit, TRANSFER_UPDATE } from "@/lib/audit";
import { easternToday, parseIsoDay } from "./eastern-day";
import { CLIENT_REQUEST_SOURCES, type ClientRequestSource } from "./client-request-sources";

// The date the client requested the transfer and where the request
// came from, shown as "Client requested" in the transfer's key dates.

export { CLIENT_REQUEST_SOURCES, type ClientRequestSource };

export type ClientRequestInput = { requestedOn: string; source: string };
export type ClientRequestError = { field: "requestedOn" | "source" | "form"; message: string };
export type ClientRequestResult = { ok: true } | { ok: false; errors: ClientRequestError[] };

function isSource(value: string): value is ClientRequestSource {
  return (CLIENT_REQUEST_SOURCES as readonly string[]).includes(value);
}

export function validateClientRequest(
  input: ClientRequestInput,
  firstSubmittedOn: string | null,
  today: string = easternToday(),
): { ok: true; requestedOn: Date; source: ClientRequestSource } | { ok: false; errors: ClientRequestError[] } {
  const errors: ClientRequestError[] = [];
  const text = input.requestedOn.trim();
  const source = input.source.trim();
  const requestedOn = parseIsoDay(text);
  if (!requestedOn) errors.push({ field: "requestedOn", message: "Enter the client request date." });
  else if (text > today) errors.push({ field: "requestedOn", message: "The client request date cannot be in the future." });
  else if (firstSubmittedOn && text > firstSubmittedOn) {
    errors.push({ field: "requestedOn", message: "The client request date cannot be after the first submission date." });
  }
  if (!isSource(source)) errors.push({ field: "source", message: "Choose Client app, Client Service, or Signed paperwork as the request source." });
  if (errors.length || !requestedOn || !isSource(source)) return { ok: false, errors };
  return { ok: true, requestedOn, source };
}

/** Records or corrects the client request date and source on the transfer. */
export async function recordClientRequest(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  input: ClientRequestInput,
  enabled: boolean,
): Promise<ClientRequestResult> {
  if (!enabled) return { ok: false, errors: [{ field: "form", message: "Client requests are not available." }] };
  const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: { archived_at: true } });
  if (!transfer || transfer.archived_at) return { ok: false, errors: [{ field: "form", message: "This transfer cannot record a request." }] };
  const first = await tx.transferSubmission.findFirst({
    where: { transfer_id: transferId },
    orderBy: { submitted_on: "asc" },
    select: { submitted_on: true },
  });
  const valid = validateClientRequest(input, first ? first.submitted_on.toISOString().slice(0, 10) : null);
  if (!valid.ok) return valid;
  await tx.transfer.update({
    where: { id: transferId },
    data: { client_requested_on: valid.requestedOn, client_request_source: valid.source, updated_by: identity.email },
  });
  await writeAudit(tx, identity, {
    action: TRANSFER_UPDATE,
    entityType: "transfer",
    entityId: transferId,
    detail: { kind: "client_request", source: valid.source },
  });
  return { ok: true };
}
