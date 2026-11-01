import { prisma } from "@/lib/prisma";
import {
  redactForAdvisor,
  type AdvisorAcatRecord,
  type RedactionInput,
} from "@/lib/advisor-redaction";

// ticket: the one advisor-facing ACAT list. The tracker's /advisor page route
// and the machine read for Ops Portal both call this, so the rows, order,
// bound, and redaction cannot drift apart.
export const ADVISOR_LIST_HARD_CAP = 5000;

// ticket: Every record passes through `redactForAdvisor` so PII, account
// numbers, fee details, and ops scratch fields never make it onto the wire.
export async function loadAdvisorAcats(): Promise<AdvisorAcatRecord[]> {
  const results = await prisma.acatRecord.findMany({
    where: { deletedAt: null },
    // Eager-load the custodian so the advisor view's SLA / aging
    // indicator works without a second fetch. The redactor only
    // surfaces id / name / avgProcessingDays — fee + contact info
    // are dropped.
    include: { custodian: true },
    orderBy: [{ acatDate: "desc" }, { id: "desc" }],
    take: ADVISOR_LIST_HARD_CAP,
  });

  // The redactor's structural input type intentionally narrows what's
  // serialized; extra Prisma fields are dropped on the way out, so
  // even if a future column is added it stays invisible to advisors
  // until someone deliberately adds it to the whitelist.
  return (results as unknown as RedactionInput[]).map(redactForAdvisor);
}

// The tracker advisor page admits active ADVISOR and ADMIN people; the machine
// read applies the same rule to a work email.
export async function resolveAdvisorListAccess(
  email: string,
): Promise<"allowed" | "not_allowed"> {
  const row = await prisma.allowedUser.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { active: true, role: true },
  });
  return row?.active && (row.role === "ADVISOR" || row.role === "ADMIN")
    ? "allowed"
    : "not_allowed";
}
