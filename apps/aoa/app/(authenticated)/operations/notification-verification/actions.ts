"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { OPERATIONS_SLACK_VERIFICATION_REQUEST_ID } from "@/lib/operations/operations-slack-verification";
import { createOperationsSlackVerification } from "@/lib/data/operations-slack-verification";

const PATH = "/operations/notification-verification";

export async function confirmOperationsSlackVerification(form: FormData): Promise<void> {
  // Next server actions also validate Origin against Host. Refuse browser
  // cross-site submissions explicitly, before authentication or any write.
  const requestHeaders = await headers();
  if (requestHeaders.get("sec-fetch-site") === "cross-site") redirect(`${PATH}?result=denied`);
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const email = session?.user?.email;
  if (!session?.navigationScope || !canAccessOperationsTools(role)
    || typeof email !== "string" || !email.trim()
    || !Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= Date.now()) {
    redirect(`${PATH}?result=denied`);
  }
  // A browser cannot choose another identity, request, destination or message.
  const keys = [...form.keys()].filter((key) => !key.startsWith("$ACTION_"));
  if (keys.length !== 1 || keys[0] !== "confirm"
    || form.get("confirm") !== OPERATIONS_SLACK_VERIFICATION_REQUEST_ID) {
    redirect(`${PATH}?result=denied`);
  }
  let result = "unavailable";
  try {
    await createOperationsSlackVerification({ role, email });
    result = "recorded";
  } catch {
    // No retry, queue repair or raw error contents. Inspect the read-only state.
  }
  redirect(`${PATH}?result=${result}`);
}
