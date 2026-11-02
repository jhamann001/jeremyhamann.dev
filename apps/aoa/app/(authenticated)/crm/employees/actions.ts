"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  applyEmployeeRoster,
  canManageEmployeeRoster,
  createEmployeeRosterPreview,
  decideEmployeeContactMapping,
  employeeContactCandidates,
  type EmployeeContactCandidate,
} from "@/lib/data/employee-roster";
import {
  EmployeeRosterParseError,
  EMPLOYEE_ROSTER_MAX_BYTES,
  parseEmployeeRosterWorkbook,
} from "@/lib/employee-roster/parser";

const value = (formData: FormData, key: string): string =>
  String(formData.get(key) ?? "").trim();
const isUploadId = (input: string): boolean => /^c[a-z0-9]{24,30}$/.test(input);
const isEntryId = (input: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);

function identityFrom(session: {
  user?: { role?: string; email?: string | null } | null;
} | null) {
  return {
    role: (session?.user as { role?: string } | undefined)?.role ?? "VIEWER",
    email: session?.user?.email ?? null,
  };
}

export async function previewEmployeeRoster(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = identityFrom(session);
  if (!canManageEmployeeRoster(identity.role)) {
    return redirect("/crm/employees?message=forbidden");
  }
  const workbook = formData.get("workbook");
  const effectiveDate = value(formData, "effectiveDate");
  if (!(workbook instanceof File)
      || !workbook.name.toLowerCase().endsWith(".xlsx")
      || workbook.size === 0 || workbook.size > EMPLOYEE_ROSTER_MAX_BYTES) {
    redirect("/crm/employees?message=invalid-file");
  }
  let parsed;
  try {
    parsed = await parseEmployeeRosterWorkbook(
      Buffer.from(await workbook.arrayBuffer()),
    );
  } catch (error) {
    const code = error instanceof EmployeeRosterParseError
      ? error.code.toLowerCase().replaceAll("_", "-")
      : "invalid-workbook";
    redirect(`/crm/employees?message=${encodeURIComponent(code)}`);
  }
  const outcome = await createEmployeeRosterPreview(identity, parsed, effectiveDate);
  if (!("uploadId" in outcome)) {
    redirect(`/crm/employees?message=${outcome.status === "forbidden" ? "forbidden" : "invalid-roster"}`);
  }
  revalidatePath("/crm/employees");
  redirect(`/crm/employees?upload=${encodeURIComponent(outcome.uploadId)}&message=${outcome.status}`);
}

export async function applyEmployeeRosterSnapshot(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const uploadId = value(formData, "uploadId");
  if (!isUploadId(uploadId)) return redirect("/crm/employees?message=invalid");
  const outcome = await applyEmployeeRoster(identityFrom(session), uploadId);
  revalidatePath("/crm/employees");
  revalidatePath("/households");
  revalidatePath("/client-portrait");
  redirect(`/crm/employees?upload=${encodeURIComponent(uploadId)}&message=${outcome}`);
}

export async function saveEmployeeContactDecision(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const uploadId = value(formData, "uploadId");
  const entryId = value(formData, "entryId");
  const crmId = value(formData, "crmId");
  const clientSfId = value(formData, "clientSfId");
  const decision = value(formData, "decision");
  if (!isUploadId(uploadId) || !isEntryId(entryId)) {
    return redirect("/crm/employees?message=invalid");
  }
  const outcome = decision === "CONFIRMED" || decision === "REJECTED"
    ? await decideEmployeeContactMapping(identityFrom(session), {
      entryId, crmId, clientSfId, decision,
    })
    : "invalid";
  revalidatePath("/crm/employees");
  revalidatePath("/households");
  revalidatePath("/client-portrait");
  const params = new URLSearchParams({
    upload: uploadId,
    entry: entryId,
    message: outcome,
  });
  redirect(`/crm/employees?${params.toString()}#match-review`);
}

export type EmployeeContactSearchState = {
  query: string;
  candidates: EmployeeContactCandidate[];
  previousRejections: EmployeeContactCandidate[];
  error: string | null;
};

export async function searchEmployeeContacts(
  _previous: EmployeeContactSearchState,
  formData: FormData,
): Promise<EmployeeContactSearchState> {
  const session = await auth();
  if (!session?.user) {
    return { query: "", candidates: [], previousRejections: [], error: "Sign in required." };
  }
  const identity = identityFrom(session);
  if (!canManageEmployeeRoster(identity.role)) {
    return { query: "", candidates: [], previousRejections: [], error: "Not authorized." };
  }
  const entryId = value(formData, "entryId");
  const query = value(formData, "query");
  if (query.length < 2 || query.length > 120) {
    return { query, candidates: [], previousRejections: [], error: "Enter at least 2 characters." };
  }
  const result = await employeeContactCandidates(identity, entryId, query);
  return { query, ...result, error: null };
}
