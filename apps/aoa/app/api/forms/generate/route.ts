import { auth } from "@/auth";
import { generateForm } from "@/lib/forms/generate-form.server";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import { paperworkDownloadAllowed } from "@/lib/data/transfer-paperwork-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function error(status: number, code: string, details?: unknown) {
  return Response.json(
    { error: code, ...(details === undefined ? {} : { details }) },
    { status, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return error(401, "unauthorized");

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 100_000) {
    return error(413, "payload_too_large");
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > 100_000) {
      return error(413, "payload_too_large");
    }
    body = JSON.parse(rawBody);
  } catch {
    return error(400, "invalid_json");
  }
  if (!isRecord(body)) return error(400, "invalid_payload");

  // Asset Transfer workspace downloads (ATW-04) carry transferId and must pass
  // the approval, review and intake gates. Requests without it are unchanged.
  const transferId = typeof body.transferId === "string" ? body.transferId.trim() : "";
  if (transferId) {
    const identity = {
      role: (session.user as { role?: string }).role ?? "VIEWER",
      email: session.user.email ?? null,
    };
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const formId = typeof body.formId === "string" ? body.formId.trim() : "";
    const accountIds = Array.isArray(body.accountIds)
      ? body.accountIds
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    const accountId = accountIds.length === 1 ? accountIds[0] : "";
    if (
      body.formId !== ACAT_DEFINITION.id ||
      !(await paperworkDownloadAllowed(identity, transferId, clientId, accountId, formId))
    ) {
      return error(403, "paperwork_not_ready");
    }
  }

  const result = await generateForm(
    {
      role: (session.user as { role?: string }).role ?? "VIEWER",
      email: session.user.email ?? null,
    },
    {
      formId: typeof body.formId === "string" ? body.formId.trim() : "",
      clientId: typeof body.clientId === "string" ? body.clientId.trim() : "",
      accountIds: Array.isArray(body.accountIds)
        ? body.accountIds
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        : [],
      values: body.values,
    },
  );

  if (!result.ok) return error(result.status, result.code, result.issues);

  return new Response(Buffer.from(result.bytes), {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "X-AoA-Form-Id": result.definition.id,
      "X-AoA-Form-Version": result.definition.version,
      "X-AoA-Review-State": result.reviewState,
      "X-AoA-Client-Completion-Required": String(result.clientCompletionRequired),
      "X-AoA-Provenance-Fields": String(result.provenance.length),
    },
  });
}
