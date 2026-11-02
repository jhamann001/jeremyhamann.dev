import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { Button, Card, CardBody, CardHeader, Pill, SectionLabel } from "@/components/ui";
import { CrmExplorerLink } from "@/components/crm";
import { ListBackLink } from "@/components/navigation/ListBackLink";
import {
  CRM_DUPLICATE_CONFLICT_LABELS,
  CRM_DUPLICATE_CONFIRM_REASONS,
  CRM_DUPLICATE_EVIDENCE_LABELS,
  CRM_DUPLICATE_REASON_LABELS,
  CRM_DUPLICATE_REJECT_REASONS,
  getCrmDuplicateCandidateDetail,
  isCrmContactIdentityOverrideEligible,
  type CrmDuplicateHouseholdSide,
} from "@/lib/data/crm-duplicate-review";
import { saveCrmDuplicateDecision } from "./actions";
import styles from "../../page.module.css";

type QueryValue = string | string[] | undefined;
const one = (value: QueryValue): string => Array.isArray(value) ? value[0] ?? "" : value ?? "";

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "America/New_York", timeZoneName: "short",
  }).format(new Date(value));
}

function formatCurrency(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(Number(value));
}

function statusLabel(status: string): string {
  return status.toLowerCase().replaceAll("_", " ");
}

function recommendationLabel(value: string): string {
  if (value === "CONFIRM_DUPLICATE") return "Likely duplicate";
  if (value === "KEEP_SEPARATE") return "Likely separate records";
  return "Manual review needed";
}

function crmRecordLabel(side: CrmDuplicateHouseholdSide): string {
  return side.crmId
    ? `CRM ID ${side.crmId}`
    : `CRM ID unavailable · CRM ID ${side.crmIdentityId}`;
}

function RecordComparison({ side }: { side: CrmDuplicateHouseholdSide }) {
  const operationalCount = side.dealCount + side.transferCount + side.taskCount
    + side.activityCount + side.emailCount + side.appointmentCount;
  return (
    <section className={styles.duplicateSide}>
      <div className={styles.duplicateSideHeader}>
        <div>
          <h3>{side.name}</h3>
          <p className={styles.secondary}>
            {side.entityType === "CONTACT"
              ? side.householdName ?? "Household not published"
              : side.status ?? "Status not published"}
          </p>
        </div>
        <CrmExplorerLink href={`/crm/${encodeURIComponent(side.crmIdentityId)}`}>Inspect CRM ID →</CrmExplorerLink>
      </div>
      {side.entityType === "CONTACT" ? (
        <dl className={styles.duplicateMetrics}>
          <div><dt>Accounts</dt><dd>{side.openAccountCount} open · {side.closedAccountCount} closed</dd></div>
          <div><dt>Account AUM</dt><dd>{formatCurrency(side.accountAum)}</dd></div>
          <div><dt>Deals</dt><dd>{side.dealCount}</dd></div>
          <div><dt>Appointments</dt><dd>{side.appointmentCount}</dd></div>
          <div><dt>Email</dt><dd>{side.hasEmail ? "On file" : "Not published"}</dd></div>
          <div><dt>Cedar Ridge identity</dt><dd>{side.hasCedarRidgeUserId ? "Linked" : "Not linked"}</dd></div>
          <div><dt>Source freshness</dt><dd>{formatDate(side.sourceFreshness)}</dd></div>
        </dl>
      ) : (
        <>
          <dl className={styles.duplicateMetrics}>
            <div><dt>Members</dt><dd>{side.memberCount}</dd></div>
            <div><dt>Accounts</dt><dd>{side.openAccountCount} open · {side.closedAccountCount} closed</dd></div>
            <div><dt>Account AUM</dt><dd>{formatCurrency(side.accountAum)}</dd></div>
            <div><dt>Operational records</dt><dd>{operationalCount}</dd></div>
            <div><dt>Lead advisor</dt><dd>{side.leadAdvisorEmail ?? "Not published"}</dd></div>
            <div><dt>Source freshness</dt><dd>{formatDate(side.sourceFreshness)}</dd></div>
          </dl>
          <details className={styles.duplicateBreakdown}>
            <summary>Operational record breakdown</summary>
            <p>{side.dealCount} deals · {side.transferCount} transfers · {side.taskCount} tasks · {side.activityCount} activities · {side.emailCount} emails · {side.appointmentCount} appointments</p>
          </details>
        </>
      )}
      {side.crmId && <p className={styles.secondary}>CRM ID <code>{side.crmId}</code></p>}
    </section>
  );
}

export default async function CrmDuplicateCandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, QueryValue>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const result = await getCrmDuplicateCandidateDetail(
    { role, email: session.user.email ?? null },
    decodeURIComponent(id),
  );
  if (!result.ok || !result.detail) notFound();
  const candidate = result.detail;
  const reviewMessage = one(sp.reviewMessage);
  const hasHardConflict = candidate.hardConflictCodes.length > 0;
  const canAcceptContactIdentityConflict = isCrmContactIdentityOverrideEligible(candidate);
  const canonicalSide = candidate.canonicalIdentityId === candidate.leftIdentityId
    ? candidate.left
    : candidate.canonicalIdentityId === candidate.rightIdentityId
      ? candidate.right
      : null;
  const confirmReasons = candidate.entityType === "CONTACT"
    ? CRM_DUPLICATE_CONFIRM_REASONS.filter((reason) => reason === "SAME_PERSON_SOURCE_DUPLICATE")
    : CRM_DUPLICATE_CONFIRM_REASONS.filter((reason) => reason !== "SAME_PERSON_SOURCE_DUPLICATE");

  return (
    <>
      <ListBackLink scope={session.navigationScope ?? ""} detailHref={`/crm/duplicates/${encodeURIComponent(candidate.id)}`} fallback="/crm?duplicates=potential" className={styles.backLink}>
        ← Duplicate reviews
      </ListBackLink>
      <SectionLabel>Admin · CRM Explorer · Duplicate review</SectionLabel>
      <div className={styles.titleRow}>
        <div>
          <h1>Compare source records</h1>
          <p className={styles.intro}>
            Review evidence and record a decision. This page cannot merge, delete, or change CRM records.
          </p>
        </div>
        <div className={styles.titlePills}>
          <Pill tone="blue">{candidate.entityType}</Pill>
          <Pill tone={candidate.status === "READY_FOR_FOLLOW_UP" ? "amber" : "gray"}>
            {statusLabel(candidate.status)}
          </Pill>
        </div>
      </div>

      <Card className={styles.sectionCard}>
        <CardHeader className={styles.cardHeader}>
          <div><h2>Why this pair was flagged</h2><p className={styles.cardHint}>Only controlled detector or Operations-submitted evidence is shown.</p></div>
          <Pill tone={hasHardConflict ? "red" : "green"}>{hasHardConflict ? "Conflict found" : "No blocking conflict"}</Pill>
        </CardHeader>
        <CardBody className={styles.duplicateEvidence}>
          {candidate.evidenceCodes.map((code) => (
            <div key={code}><Pill tone="green">Evidence</Pill><span>{CRM_DUPLICATE_EVIDENCE_LABELS[code]}</span></div>
          ))}
          {candidate.operatorFlagged && !candidate.evidenceCodes.includes("OPERATOR_SUBMITTED") && (
            <div><Pill tone="blue">Operations</Pill><span>Operations also flagged these CRM IDs for comparison.</span></div>
          )}
          {candidate.hardConflictCodes.map((code) => (
            <div key={code}><Pill tone="red">Blocks follow-up</Pill><span>{CRM_DUPLICATE_CONFLICT_LABELS[code]}</span></div>
          ))}
          {candidate.entityType === "ACCOUNT" && (
            <p className={styles.secondary}>Exact custodial identity ending {candidate.accountEnding ?? "unavailable"}. Distinct account IDs, including Companion/main pairs, are never classified as duplicates.</p>
          )}
        </CardBody>
      </Card>

      <Card className={styles.sectionCard}>
        <CardHeader className={styles.cardHeader}>
          <div>
            <h2>AOA shadow recommendation</h2>
            <p className={styles.cardHint}>The recommendation learns from comparable completed reviews. It never saves or applies a decision.</p>
          </div>
          <Pill tone="blue">Shadow only · {candidate.learning.confidence.toLowerCase()} confidence</Pill>
        </CardHeader>
        <CardBody className={styles.learningSummary}>
          <div>
            <strong>{recommendationLabel(candidate.learning.recommendation)}</strong>
            <p>{candidate.learning.explanation}</p>
          </div>
          <dl>
            <div><dt>Similar reviewed</dt><dd>{candidate.learning.similarReviewed}</dd></div>
            <div><dt>Confirmed duplicate</dt><dd>{candidate.learning.similarConfirmed}</dd></div>
            <div><dt>Kept separate</dt><dd>{candidate.learning.similarRejected}</dd></div>
          </dl>
          <p className={styles.learningNote}>Phase 1 observes whether the recommendation agrees with you. Nothing is preselected and no CRM record is changed.</p>
        </CardBody>
      </Card>

      <div className={styles.duplicateComparison}>
        <RecordComparison side={candidate.left} />
        <div className={styles.duplicateVs} aria-hidden="true">versus</div>
        <RecordComparison side={candidate.right} />
      </div>

      <Card id="review-decision" className={styles.sectionCard}>
        <CardHeader><h2>Review decision</h2></CardHeader>
        <CardBody className={styles.duplicateDecision}>
          {reviewMessage === "saved" && <p className={styles.successAlert} role="status">Decision saved. Future detector runs will preserve it.</p>}
          {reviewMessage === "reopened" && <p className={styles.successAlert} role="status">Review reopened. The AOA canonicalization has been removed.</p>}
          {reviewMessage === "flagged" && <p className={styles.successAlert} role="status">Possible duplicate flagged. Compare the two CRM records below, then record a decision.</p>}
          {reviewMessage && !["saved", "reopened", "flagged"].includes(reviewMessage) && <p className={styles.errorAlert} role="alert">The decision was not saved. Reload the candidate and try again.</p>}
          {!candidate.sourceActive && (
            <p className={styles.errorAlert}>
              The source signal is no longer active. A confirmed AOA overlay can still be reopened,
              but no new duplicate outcome can be recorded.
            </p>
          )}
          {candidate.decisionReason && (
            <div className={styles.currentOutcome}>
              <strong>Current human outcome</strong>
              <p>
                {CRM_DUPLICATE_REASON_LABELS[candidate.decisionReason]}
                {canonicalSide ? ` · Record to preserve: ${crmRecordLabel(canonicalSide)}` : ""}
              </p>
            </div>
          )}
          {candidate.acceptedHardConflictCodes.length > 0 && (
            <div className={styles.currentOutcome}>
              <strong>Verified contact identity warning</strong>
              <p>
                {candidate.conflictOverrideBy ?? "Operations"} accepted the differing Cedar Ridge
                identity warning after reviewing the source records
                {candidate.conflictOverrideAt ? ` on ${formatDate(candidate.conflictOverrideAt)}` : ""}.
                A different or additional conflict will remove this AOA canonicalization.
              </p>
            </div>
          )}
          {candidate.status === "READY_FOR_FOLLOW_UP" && canonicalSide && (
            <div className={styles.currentOutcome}>
              <strong>AOA canonicalization is active</strong>
              <p>
                Normal AOA {candidate.entityType === "CONTACT" ? "client" : "household"} browsing now
                preserves {" "}{crmRecordLabel(canonicalSide)} and redirects the other
                {" "}{candidate.entityType === "CONTACT" ? "contact" : "household"} to it. CRM remains unchanged.
              </p>
              <form action={saveCrmDuplicateDecision}>
                <input type="hidden" name="candidateId" value={candidate.id} />
                <input type="hidden" name="expectedReviewVersion" value={candidate.reviewVersion} />
                <input type="hidden" name="decision" value="NEW" />
                <Button type="submit" variant="ghost">Reopen review and remove AOA canonicalization</Button>
              </form>
            </div>
          )}

          <div className={styles.duplicateActions}>
            <form action={saveCrmDuplicateDecision}>
              <input type="hidden" name="candidateId" value={candidate.id} />
              <input type="hidden" name="expectedReviewVersion" value={candidate.reviewVersion} />
              <input type="hidden" name="decision" value="READY_FOR_FOLLOW_UP" />
              <label>
                CRM record to preserve
                <select name="canonicalIdentityId" defaultValue="" required>
                  <option value="" disabled>Choose the CRM ID to preserve</option>
                  <option value={candidate.leftIdentityId}>{crmRecordLabel(candidate.left)}</option>
                  <option value={candidate.rightIdentityId}>{crmRecordLabel(candidate.right)}</option>
                </select>
              </label>
              <label>
                Why they are duplicates
                <select name="decisionReason" defaultValue="" required>
                  <option value="" disabled>Choose a reason</option>
                  {confirmReasons.map((reason) => (
                    <option key={reason} value={reason}>{CRM_DUPLICATE_REASON_LABELS[reason]}</option>
                  ))}
                </select>
              </label>
              {canAcceptContactIdentityConflict && (
                <label className={styles.conflictOverride}>
                  <input
                    type="checkbox"
                    name="acceptContactIdentityConflict"
                    value="confirmed"
                    required
                  />
                  <span>
                    I verified in CRM that these records are the same person despite their
                    different Cedar Ridge identities. Preserve my selected CRM ID in AOA.
                  </span>
                </label>
              )}
              <Button
                type="submit"
                disabled={!candidate.sourceActive || (hasHardConflict && !canAcceptContactIdentityConflict)}
              >
                Confirm duplicate
              </Button>
              <p>Choose by CRM ID because the record names may be identical. This does not merge or change either record.</p>
            </form>
            <form action={saveCrmDuplicateDecision}>
              <input type="hidden" name="candidateId" value={candidate.id} />
              <input type="hidden" name="expectedReviewVersion" value={candidate.reviewVersion} />
              <input type="hidden" name="decision" value="NOT_DUPLICATE" />
              <label>
                Why they should stay separate
                <select name="decisionReason" defaultValue="" required>
                  <option value="" disabled>Choose a reason</option>
                  {CRM_DUPLICATE_REJECT_REASONS.map((reason) => (
                    <option key={reason} value={reason}>{CRM_DUPLICATE_REASON_LABELS[reason]}</option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={!candidate.sourceActive}>Not duplicate</Button>
              <p>Keeps both records and teaches AOA that this signal pattern can be a false positive.</p>
            </form>
            <form action={saveCrmDuplicateDecision}>
              <input type="hidden" name="candidateId" value={candidate.id} />
              <input type="hidden" name="expectedReviewVersion" value={candidate.reviewVersion} />
              <input type="hidden" name="decision" value="SNOOZED" />
              <label>Snooze until <input type="date" name="snoozedUntil" required /></label>
              <Button type="submit" disabled={!candidate.sourceActive}>Snooze</Button>
              <p>Hides it from the active count temporarily and does not train the recommendation.</p>
            </form>
          </div>
          {hasHardConflict && !canAcceptContactIdentityConflict && (
            <p className={styles.learningNote}>Resolve the blocking identity conflict before confirming this pair as a duplicate.</p>
          )}
          {canAcceptContactIdentityConflict && (
            <p className={styles.learningNote}>
              This one contact-only warning can be accepted after a read-only CRM review.
              Any different or additional conflict will still block confirmation.
            </p>
          )}
        </CardBody>
      </Card>

      <Card className={styles.sectionCard}>
        <CardHeader><h2>Decision history</h2></CardHeader>
        <CardBody>
          <div className={styles.duplicateHistory}>
            {candidate.events.map((event) => (
              <div key={`${event.action}-${event.at}`}>
                <strong>
                  {statusLabel(event.action)}
                  {event.reason ? ` · ${CRM_DUPLICATE_REASON_LABELS[event.reason]}` : ""}
                  {event.canonicalSide ? ` · canonical ${event.canonicalSide.toLowerCase()} record` : ""}
                </strong>
                <span>{formatDate(event.at)}{event.actorEmail ? ` · ${event.actorEmail}` : " · detector"}</span>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </>
  );
}
