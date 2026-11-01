import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  OAuthError,
  assertMcpEnabledForUser,
  parseAuthorizationRequest,
  validateAuthorizationRequest,
} from "@/lib/mcp/oauth";
import { scopeString } from "@/lib/mcp/scopes";

type AuthorizePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildQuery(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) q.set(key, value);
  }
  return q.toString();
}

export default async function McpOAuthAuthorizePage({
  searchParams,
}: AuthorizePageProps) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/");
  }

  const raw = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const v = first(value);
    if (v != null) urlParams.set(key, v);
  }

  let errorMessage: string | null = null;
  let consent:
    | {
        request: ReturnType<typeof parseAuthorizationRequest>;
        clientName: string | null;
        scopes: string[];
      }
    | null = null;

  try {
    await assertMcpEnabledForUser(session.user.email);
    const request = parseAuthorizationRequest(urlParams);
    const { client, scopes } = await validateAuthorizationRequest(request);
    consent = { request, clientName: client.clientName, scopes };
  } catch (err) {
    errorMessage =
      err instanceof OAuthError || err instanceof Error
        ? err.message
        : "Unable to authorize MCP connection";
  }

  if (!consent) {
    return (
      <div className="min-h-screen bg-surface px-6 py-12 text-foreground">
        <main className="mx-auto max-w-xl rounded-2xl border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] p-8">
          <h1 className="mb-3 text-2xl font-semibold">MCP connection unavailable</h1>
          <p className="text-sm">{errorMessage}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface px-6 py-12 text-foreground">
      <main className="mx-auto max-w-xl rounded-2xl border border-card-border bg-[var(--bg-card)] p-8 shadow-sm">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
          Claude connection
        </p>
        <h1 className="mb-3 text-2xl font-semibold">Allow Transfer Tracker MCP access?</h1>
        <p className="mb-6 text-sm text-muted">
          {consent.clientName || "Claude"} is requesting read-only access to Transfer Tracker data
          through the remote MCP connector.
        </p>

        <div className="mb-6 rounded-xl border border-card-border bg-[var(--bg-hover)] p-4">
          <p className="mb-2 text-sm font-semibold">Requested scopes</p>
          <ul className="space-y-1 text-sm text-muted">
            {consent.scopes.map((scope) => (
              <li key={scope}>{scope}</li>
            ))}
          </ul>
        </div>

        <form method="post" action="/api/mcp/oauth/authorize/approve" className="flex gap-3">
          <input type="hidden" name="client_id" value={consent.request.clientId} />
          <input type="hidden" name="redirect_uri" value={consent.request.redirectUri} />
          <input type="hidden" name="state" value={consent.request.state ?? ""} />
          <input type="hidden" name="scope" value={scopeString(consent.scopes)} />
          <input type="hidden" name="code_challenge" value={consent.request.codeChallenge} />
          <button
            type="submit"
            className="rounded-lg bg-[var(--invert-bg)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)]"
          >
            Allow
          </button>
          <a
            href={`/?${buildQuery({ mcp: "denied" })}`}
            className="rounded-lg border border-card-border px-4 py-2 text-sm text-muted"
          >
            Cancel
          </a>
        </form>
      </main>
    </div>
  );
}
