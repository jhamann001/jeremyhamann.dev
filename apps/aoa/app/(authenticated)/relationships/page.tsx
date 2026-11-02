import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { CrmExplorerLink, RelationshipWorkspace } from "@/components/crm";
import { Button, Card, CardBody, CardHeader, Pill, SectionLabel } from "@/components/ui";
import { crmRelationshipsEnabled } from "@/lib/flags";
import { searchCrmRelationshipHouseholds } from "@/lib/data/crm-relationship-workspace";
import {
  canReadCrmRelationships,
  validateCrmRelationshipRoot,
} from "@/lib/data/crm-relationships";

type QueryValue = string | string[] | undefined;

function one(value: QueryValue): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function RelationshipsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, QueryValue>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!crmRelationshipsEnabled() || !canReadCrmRelationships(role)) {
    notFound();
  }

  const params = await searchParams;
  const rootIdentityId = one(params.root).trim();
  const householdQuery = one(params.household).trim().slice(0, 100);
  const rootValidation = rootIdentityId
    ? validateCrmRelationshipRoot(rootIdentityId)
    : null;
  const identity = { role, email: session.user.email ?? null };
  const householdSearch = householdQuery.length >= 2
    ? await searchCrmRelationshipHouseholds(identity, householdQuery)
    : null;
  if (householdSearch && !householdSearch.ok) notFound();

  return (
    <>
      <SectionLabel>Firm · CRM relationship layer</SectionLabel>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1>Relationships</h1>
          <p style={{ color: "var(--muted)", marginTop: 7, maxWidth: 760 }}>
            Review exact, active parent and child links between households, people, deals, and asset transfers.
          </p>
        </div>
        <Pill tone="green" dot>Live CRM data</Pill>
      </div>

      <Card style={{ marginTop: 22 }}>
        <CardHeader>
          <div>
            <h2>Choose a starting record</h2>
            <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
              Search by household or member name, enter a CRM ID, or open a record from CRM Explorer.
            </p>
          </div>
        </CardHeader>
        <CardBody>
          <form action="/relationships" method="get" style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "grid", gap: 6, minWidth: "min(100%, 420px)", flex: "1 1 320px", fontSize: 12, color: "var(--muted)" }}>
              Household or member name
              <input
                name="household"
                defaultValue={householdQuery}
                minLength={2}
                maxLength={100}
                autoComplete="off"
                placeholder="Start typing a household or member name"
                style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--input-bg)", color: "var(--ink)" }}
              />
            </label>
            <Button type="submit">Search households</Button>
          </form>
          {householdQuery.length === 1 ? (
            <p role="alert" style={{ marginTop: 12, color: "var(--amber)", fontSize: 12 }}>
              Enter at least two characters to search household or member names.
            </p>
          ) : null}
          {householdSearch?.ok ? (
            householdSearch.rows.length > 0 ? (
              <ul style={{ display: "grid", gap: 8, marginTop: 14, listStyle: "none" }}>
                {householdSearch.rows.map((match) => (
                  <li
                    key={match.identityId}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 9, background: "var(--bg)" }}
                  >
                    <div>
                      <strong style={{ display: "block", fontSize: 12 }}>{match.name}</strong>
                      <span style={{ color: "var(--muted)", fontSize: 10 }}>CRM ID {match.crmId}</span>
                    </div>
                    <CrmExplorerLink href={`/relationships?root=${encodeURIComponent(match.identityId)}`}>
                      Open map →
                    </CrmExplorerLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ marginTop: 12, color: "var(--muted)", fontSize: 12 }}>
                No household matches found.
              </p>
            )
          ) : null}

          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "var(--muted)", fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" }}>
            <span style={{ height: 1, flex: 1, background: "var(--line)" }} />
            Or use a CRM ID
            <span style={{ height: 1, flex: 1, background: "var(--line)" }} />
          </div>
          <form action="/relationships" method="get" style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "grid", gap: 6, minWidth: "min(100%, 420px)", flex: "1 1 320px", fontSize: 12, color: "var(--muted)" }}>
              CRM ID
              <input
                name="root"
                defaultValue={rootIdentityId}
                maxLength={64}
                autoComplete="off"
                placeholder="hld_… or con_…"
                style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--input-bg)", color: "var(--ink)" }}
              />
            </label>
            <Button type="submit">Show relationships</Button>
            <CrmExplorerLink href="/crm" className="btn">Open CRM Explorer</CrmExplorerLink>
          </form>
          {rootIdentityId && rootValidation && !rootValidation.ok ? (
            <p role="alert" style={{ marginTop: 12, color: "var(--red)", fontSize: 12 }}>
              Enter an active household, contact, deal, or transfer CRM ID.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div style={{ marginTop: 18 }}>
        {rootValidation?.ok ? (
          <RelationshipWorkspace
            identity={identity}
            rootIdentityId={rootIdentityId}
          />
        ) : !rootIdentityId ? (
          <Card>
            <CardBody>
              <p style={{ color: "var(--muted)" }}>
                Start from a CRM record to see its parent and child nodes.
              </p>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
