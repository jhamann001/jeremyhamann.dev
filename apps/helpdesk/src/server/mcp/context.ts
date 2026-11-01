/**
 * Who an MCP call is — node, layer L4.
 *
 * "Bearer = `ClientApiToken` with scope `mcp` **acting as its creator**". That sentence is the whole
 * authorization model on this surface, and it is deliberately not a new one:
 *
 *  - An agent holds no permissions of its own. It borrows the ones the person who issued its
 *    credential already had, so there is no second RBAC matrix to keep in step with `src/lib/rbac.ts`
 *    and no capability an agent can hold that a human could not.
 *  - Those permissions are re-read from the `User` row on EVERY call, and an inactive creator refuses
 *    the call outright. Offboarding somebody therefore kills their agent's access on the next
 *    request, without an administrator having to remember that the agent exists.
 *  - Groups come from `User.groups` (the snapshot refreshed at sign-in) rather than from a JWT,
 *    because there is no session here. That is the same source `listAssignableUsers` trusts, and it
 *    is stale only in the window between an Okta change and the creator's next sign-in — which is the
 *    existing, documented behaviour of that column, not a new exposure.
 *
 * A caller with no groups is not an error: it is a viewer who can read no queue, so every tool
 * answers empty and `add_internal_note` refuses. `isStaff` is the same fact stated positively, and is
 * what `get_ticket` uses to decide whether INTERNAL notes are part of the answer.
 */
import type { AuditActor, AuditEntry, OktaGroup, RequestContext, Viewer } from "@/types/domain";
import type { VerifiedToken } from "@/lib/api-tokens";
import { AUDIT_VIA, actorFromViewer, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { readableQueues } from "@/lib/rbac";

export type McpCaller = {
  token: VerifiedToken;
  /** The token's creator, as the desk's own viewer type. */
  viewer: Viewer;
  actor: AuditActor;
  /** True when the creator can read at least one queue — i.e. when this is a STAFF token. */
  isStaff: boolean;
};

/**
 * Resolves a verified `mcp` token to its creator.
 *
 * `null` when the creator's row is missing or deactivated. Fails closed for the same reason
 * `integrationActor` does: without a live `User` row there is no foreign key for `AuditLog.actorId`,
 * and an unattributable write to a books-and-records system is not a write this desk makes.
 */
export async function resolveMcpCaller(token: VerifiedToken): Promise<McpCaller | null> {
  const row = await prisma.clientApiToken.findUnique({
    where: { id: token.id },
    select: {
      createdBy: { select: { id: true, email: true, name: true, image: true, groups: true, isActive: true } },
    },
  });
  if (row === null || !row.createdBy.isActive) return null;

  const groups: OktaGroup[] = [...row.createdBy.groups];
  const viewer: Viewer = {
    id: row.createdBy.id,
    email: row.createdBy.email,
    name: row.createdBy.name,
    image: row.createdBy.image,
    groups,
    // Never a dev persona. A dev-login session is a local convenience; a credential is not.
    isDev: false,
  };
  return {
    token,
    viewer,
    actor: actorFromViewer(viewer),
    isStaff: readableQueues(groups).length > 0,
  };
}

/**
 * One audit row for an MCP-borne event, with `metadata.via = "mcp"` (§3 rule 1).
 *
 * The `via` value is the point of this helper. "An agent acting on a person's behalf is a different
 * fact from a workflow posting": the actor columns say `mia@…`, because the agent genuinely acts as
 * her, and `via: "mcp"` is what stops that row being read as Mia at a keyboard. `tokenId` says WHICH
 * agent, so a credential that misbehaves can be found in `/admin/api-tokens` and revoked. The prefix
 * is deliberately NOT carried: the id is enough to find the row, and the fewer places a credential's
 * public half is copied to, the fewer places it has to be redacted from later.
 *
 * Awaited, outside any transaction the caller has not opened, errors propagating: a read whose
 * ledger row fails serves nothing, and a write that cannot be recorded is not committed.
 */
export async function auditMcp(
  caller: McpCaller,
  ctx: RequestContext,
  tool: string,
  entry: Omit<AuditEntry, "metadata">,
  extra?: McpAuditExtra,
): Promise<void> {
  await writeAudit(prisma, caller.actor, ctx, { ...entry, metadata: mcpMetadata(caller, tool, extra) });
}

/** What an MCP audit row's metadata may carry beyond the three fixed keys. Scalars only — never a body. */
export type McpAuditExtra = Record<string, string | number | boolean | null>;

/** The same `metadata` block, for a caller that writes its own rows through `writeAuditMany`. */
export function mcpMetadata(caller: McpCaller, tool: string, extra?: McpAuditExtra): McpAuditExtra {
  return { ...(extra ?? {}), via: AUDIT_VIA.mcp, tool, tokenId: caller.token.id };
}
