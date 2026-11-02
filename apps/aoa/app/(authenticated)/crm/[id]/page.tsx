import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { Button, Card, CardBody, CardHeader, Pill, SectionLabel, StatTile } from "@/components/ui";
import { CrmExplorerLink } from "@/components/crm";
import { ListBackLink } from "@/components/navigation/ListBackLink";
import { CanonicalCrmRoute } from "@/components/crm/CanonicalCrmRoute";
import {
  crmExplorerAvailable,
  getCrmIdentityDetail,
  type CrmExplorerMapping,
} from "@/lib/data/crm-explorer";
import {
  allowedCrmParentTypes,
  crmParentSuggestionQuery,
  searchCrmParentCandidatesForReview,
} from "@/lib/data/crm-parent-resolution";
import { resolveCrmDuplicateCanonicalIdentity } from "@/lib/data/crm-duplicate-review";
import { confirmCrmParentMapping } from "./actions";
import { crmRelationshipsEnabled } from "@/lib/flags";
import {
  canReadCrmRelationships,
  validateCrmRelationshipRoot,
} from "@/lib/data/crm-relationships";
import styles from "../page.module.css";

type QueryValue = string | string[] | undefined;

function one(value: QueryValue): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(value));
}

function stateTone(state: string): "green" | "amber" | "gray" {
  if (state === "ACTIVE") return "green";
  if (state === "MERGED") return "amber";
  return "gray";
}

function mappingLabel(mapping: CrmExplorerMapping): string {
  return mapping.displayName ?? `${mapping.sourceSystem} ${mapping.sourceNamespace}`;
}

export default async function CrmIdentityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, QueryValue>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!crmExplorerAvailable(role)) notFound();

  const [{ id }, queryParams] = await Promise.all([params, searchParams]);
  const identity = { role, email: session.user.email ?? null };
  const requestedCrmId = decodeURIComponent(id);
  const canonicalCrmId = await resolveCrmDuplicateCanonicalIdentity(identity, requestedCrmId);
  const result = await getCrmIdentityDetail(
    identity,
    canonicalCrmId,
  );
  if (!result.ok || !result.detail) notFound();
  const detail = result.detail;
  const relationshipMapAvailable = crmRelationshipsEnabled()
    && canReadCrmRelationships(role)
    && validateCrmRelationshipRoot(detail.id).ok;
  const openExceptions = detail.exceptions.filter((exception) => exception.state === "OPEN").length;
  const parentExceptions = detail.exceptions.filter((exception) =>
    exception.reasonCode === "MISSING_PARENT_MAPPING"
      && (exception.state === "OPEN" || exception.resolutionCode === "MANUAL_LINK"));
  const requestedException = one(queryParams.resolutionException);
  const selectedException = parentExceptions.find((exception) => exception.id === requestedException)
    ?? parentExceptions.find((exception) => exception.state === "OPEN")
    ?? parentExceptions[0];
  const selectedMapping = detail.mappings.find(
    (mapping) => mapping.id === selectedException?.sourceMappingId,
  );
  const currentParent = detail.manualParents.find(
    (override) => override.sourceMappingId === selectedException?.sourceMappingId,
  );
  const requestedParentQuery = one(queryParams.parentQuery).trim().slice(0, 100);
  const suggestedParentQuery = crmParentSuggestionQuery(selectedMapping?.displayName);
  const parentQuery = requestedParentQuery || suggestedParentQuery;
  // Keep ordinary CRM detail reads independent from the broader candidate
  // search. The suggestion is prefilled, but the bounded search runs only
  // after the operator explicitly submits it.
  const parentSearchSubmitted = Boolean(requestedParentQuery);
  const parentSearch = selectedException && parentSearchSubmitted
    ? await searchCrmParentCandidatesForReview(identity, detail.identityType, requestedParentQuery)
    : { status: "complete" as const, candidates: [] };
  const parentCandidates = parentSearch.candidates;
  const resolutionMessage = one(queryParams.resolutionMessage);

  return (
    <>
      {canonicalCrmId !== requestedCrmId && <CanonicalCrmRoute canonicalId={canonicalCrmId} />}
      <ListBackLink scope={session.navigationScope ?? ""} detailHref={`/crm/${encodeURIComponent(requestedCrmId)}`} canonicalHref={`/crm/${encodeURIComponent(canonicalCrmId)}`} fallback="/crm" className={styles.backLink}>← CRM Explorer</ListBackLink>
      <SectionLabel>CRM identity · {detail.identityType.toLowerCase()}</SectionLabel>
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.crmId}>{detail.id}</h1>
          <p className={styles.intro}>
            One canonical ID with every visible source alias and exact-key connection.
          </p>
        </div>
        <div className={styles.titlePills}>
          {relationshipMapAvailable ? (
            <CrmExplorerLink href={`/relationships?root=${encodeURIComponent(detail.id)}`} className="btn">
              Open relationship map
            </CrmExplorerLink>
          ) : null}
          <Pill tone="blue">{detail.identityType}</Pill>
          <Pill tone={stateTone(detail.lifecycleState)} dot>{detail.lifecycleState}</Pill>
        </div>
      </div>

      <div className={styles.stats}>
        <StatTile label="Source aliases" value={detail.mappings.length} />
        <StatTile label="Connections" value={detail.connectionTotal} />
        <StatTile label="Open exceptions" value={openExceptions} />
        <StatTile label="First registered" value={formatDate(detail.firstSeenAt)} />
      </div>

      {(detail.mergedIntoId || detail.mergedFromIds.length > 0) && (
        <Card className={styles.sectionCard}>
          <CardHeader><h2>Merge history</h2></CardHeader>
          <CardBody className={styles.stack}>
            {detail.mergedIntoId && (
              <p>This ID was merged into <CrmExplorerLink href={`/crm/${encodeURIComponent(detail.mergedIntoId)}`}><code>{detail.mergedIntoId}</code></CrmExplorerLink>.</p>
            )}
            {detail.mergedFromIds.map((mergedId) => (
              <p key={mergedId}><CrmExplorerLink href={`/crm/${encodeURIComponent(mergedId)}`}><code>{mergedId}</code></CrmExplorerLink> was merged into this ID.</p>
            ))}
          </CardBody>
        </Card>
      )}

      <Card className={styles.sectionCard}>
        <CardHeader className={styles.cardHeader}>
          <div><h2>Source aliases</h2><p className={styles.cardHint}>The IDs already used by AOA and connected systems.</p></div>
          <Pill tone="gray">{detail.mappings.length}</Pill>
        </CardHeader>
        <CardBody>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Source record</th><th>Existing ID</th><th>Registry state</th><th>Source freshness</th><th><span className={styles.srOnly}>Open source</span></th></tr></thead>
              <tbody>
                {detail.mappings.map((mapping) => (
                  <tr key={mapping.id}>
                    <td><div className={styles.primary}>{mappingLabel(mapping)}</div><div className={styles.secondary}>{mapping.sourceSystem} · {mapping.sourceNamespace}</div></td>
                    <td><code className={styles.sourceKey}>{mapping.sourceKey}</code></td>
                    <td><Pill tone={mapping.mappingState === "ACTIVE" ? "green" : "gray"}>{mapping.mappingState}</Pill></td>
                    <td>{formatDate(mapping.sourceObservedAt ?? mapping.lastSeenAt)}</td>
                    <td>{mapping.href ? <CrmExplorerLink href={mapping.href} className={styles.inspect}>Open record ↗</CrmExplorerLink> : <span className={styles.secondary}>No detail route</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card id="resolve-parent-mapping" className={styles.sectionCard}>
        <CardHeader className={styles.cardHeader}>
          <div>
            <h2>Relationship review</h2>
            <p className={styles.cardHint}>Find and save the correct parent for unresolved CRM relationships.</p>
          </div>
          <Pill tone={openExceptions > 0 ? "red" : "green"}>{openExceptions > 0 ? `${openExceptions} open` : "Clear"}</Pill>
        </CardHeader>
        <CardBody>
          {selectedException ? (
            <div className={styles.resolutionBody}>
              <div className={styles.resolutionHeading}>
                <div>
                  <h3>{currentParent ? "Confirmed parent mapping" : "Missing parent mapping"}</h3>
                  <p className={styles.cardHint}>
                    Choose the correct {allowedCrmParentTypes(detail.identityType).map((type) => type.toLowerCase()).join(" or ")} for this {detail.identityType.toLowerCase()} and save it as the parent.
                  </p>
                  <p className={styles.secondary}>Detected {formatDate(selectedException.detectedAt)}</p>
                </div>
                <Pill tone={currentParent ? "green" : "red"}>{currentParent ? "Confirmed" : "Action needed"}</Pill>
              </div>
            {resolutionMessage === "saved" && (
              <p className={styles.successAlert} role="status">Parent mapping saved. The CRM exception and its Review Queue item are resolved.</p>
            )}
            {resolutionMessage === "failed" && (
              <p className={styles.errorAlert} role="alert">That mapping could not be saved. Reload the record and try a different active parent.</p>
            )}
            <div className={styles.recordContext}>
              <span className={styles.secondary}>Record being mapped</span>
              <strong>{selectedMapping ? mappingLabel(selectedMapping) : detail.identityType}</strong>
              {selectedMapping && <code>{selectedMapping.sourceKey}</code>}
            </div>
            {currentParent && (
              <div className={styles.currentParent}>
                <div>
                  <span className={styles.secondary}>Current confirmed parent</span>
                  <strong>{currentParent.displayName ?? currentParent.parentIdentityType.toLowerCase()}</strong>
                  <code>{currentParent.parentIdentityId}</code>
                </div>
                <span className={styles.secondary}>Confirmed {formatDate(currentParent.confirmedAt)} by {currentParent.confirmedBy}</span>
              </div>
            )}
            {parentExceptions.length > 1 && (
              <div className={styles.mappingChoices} aria-label="Records requiring a parent mapping">
                {parentExceptions.map((exception, index) => {
                  const mapping = detail.mappings.find((item) => item.id === exception.sourceMappingId);
                  return (
                    <CrmExplorerLink
                      key={exception.id}
                      href={`/crm/${encodeURIComponent(detail.id)}?resolutionException=${encodeURIComponent(exception.id)}#resolve-parent-mapping`}
                      className={exception.id === selectedException.id ? styles.mappingChoiceActive : styles.mappingChoice}
                    >
                      Record {index + 1}: {mapping ? mappingLabel(mapping) : exception.id}
                    </CrmExplorerLink>
                  );
                })}
              </div>
            )}
            <form className={styles.parentSearch} method="get" action={`/crm/${encodeURIComponent(detail.id)}`}>
              <input type="hidden" name="resolutionException" value={selectedException.id} />
              <label htmlFor="parent-query">Find the correct parent</label>
              <div className={styles.parentSearchRow}>
                <input
                  id="parent-query"
                  name="parentQuery"
                  defaultValue={parentQuery}
                  maxLength={100}
                  placeholder="Search by household, client name, or CRM ID"
                />
                <Button type="submit">Find matches</Button>
              </div>
            </form>
            <div className={styles.candidateList}>
              {!parentSearchSubmitted ? (
                <p className={styles.emptyText}>Find matches, then choose “Use as parent” to save and resolve this relationship.</p>
              ) : parentSearch.status === "failed" ? (
                <p className={styles.errorAlert} role="alert">Search could not be completed. Try again.</p>
              ) : parentCandidates.length === 0 ? (
                <div className={styles.emptyText} role="status">
                  <p>No matching active contacts or households were found.</p>
                  {process.env.APP_ENV?.toLowerCase() === "dev" && (
                    <p>Production client records are not available in this environment.</p>
                  )}
                </div>
              ) : parentCandidates.map((candidate) => {
                const isCurrent = candidate.crmId === currentParent?.parentIdentityId;
                return (
                  <div className={styles.candidate} key={candidate.crmId}>
                    <div>
                      <div className={styles.candidateTitle}>
                        <strong>{candidate.displayName ?? candidate.identityType.toLowerCase()}</strong>
                        <Pill tone="blue">{candidate.identityType}</Pill>
                        {isCurrent && <Pill tone="green">Current</Pill>}
                      </div>
                      <code>{candidate.crmId}</code>
                      <p className={styles.secondary}>{candidate.sourceSystem} · {candidate.sourceNamespace}</p>
                    </div>
                    <form action={confirmCrmParentMapping}>
                      <input type="hidden" name="exceptionId" value={selectedException.id} />
                      <input type="hidden" name="childCrmId" value={detail.id} />
                      <input type="hidden" name="parentCrmId" value={candidate.crmId} />
                      <Button type="submit" variant={isCurrent ? "ghost" : "primary"} size="sm" disabled={isCurrent}>
                        {isCurrent ? "Selected" : currentParent ? "Change parent" : "Use as parent"}
                      </Button>
                    </form>
                  </div>
                );
              })}
            </div>
            <p className={styles.learningNote}>
              Each confirmation keeps the controlled record types, chosen CRM IDs, reviewer, and time. Client names and appointment text remain in their source systems; the decision history can support safer suggestions later.
            </p>
            </div>
          ) : detail.exceptions.length === 0 ? (
            <p className={styles.emptyText}>No identity-resolution exceptions.</p>
          ) : (
            <p className={styles.emptyText}>No parent relationship requires review.</p>
          )}

          {detail.exceptions.some((exception) => exception.reasonCode !== "MISSING_PARENT_MAPPING") && (
            <div className={styles.otherExceptions}>
              <h3>Other identity exceptions</h3>
              <div className={styles.exceptionList}>
                {detail.exceptions.filter((exception) => exception.reasonCode !== "MISSING_PARENT_MAPPING").map((exception) => (
                  <div className={styles.exception} key={exception.id}>
                    <div><strong>{exception.reasonCode.replaceAll("_", " ").toLowerCase()}</strong><p>Detected {formatDate(exception.detectedAt)}</p></div>
                    <Pill tone={exception.state === "OPEN" ? "red" : "green"}>{exception.state}</Pill>
                    {exception.resolutionCode && <span>{exception.resolutionCode}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card className={styles.sectionCard}>
        <CardHeader className={styles.cardHeader}>
          <div><h2>Connections</h2><p className={styles.cardHint}>Exact relationships derived from existing source keys; they do not grant access.</p></div>
          <Pill tone="gray">{detail.connectionTotal}</Pill>
        </CardHeader>
        <CardBody>
          {detail.connections.length === 0 ? (
            <p className={styles.emptyText}>No resolved parent or child connection is available for this identity.</p>
          ) : (
            <div className={styles.connectionGrid}>
              {detail.connections.map((connection, index) => (
                <div className={styles.connection} key={`${connection.relationship}-${connection.identityId}-${index}`}>
                  <div className={styles.connectionTop}>
                    <Pill tone="blue">{connection.identityType}</Pill>
                    <span className={styles.relationship}>{connection.relationship}</span>
                  </div>
                  <div className={styles.primary}>{connection.displayName ?? connection.identityType.toLowerCase()}</div>
                  <code>{connection.identityId}</code>
                  <div className={styles.connectionLinks}>
                    <CrmExplorerLink href={`/crm/${encodeURIComponent(connection.identityId)}`}>Inspect CRM ID →</CrmExplorerLink>
                    {connection.href && <CrmExplorerLink href={connection.href}>Open source record ↗</CrmExplorerLink>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {detail.connectionsTruncated && (
            <p className={styles.truncated}>Showing the first {detail.connections.length} of {detail.connectionTotal} connections.</p>
          )}
        </CardBody>
      </Card>

    </>
  );
}
