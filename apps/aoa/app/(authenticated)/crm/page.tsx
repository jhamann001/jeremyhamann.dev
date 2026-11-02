import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { CrmExplorerLink } from "@/components/crm";
import {
  CRM_EXPLORER_TYPES,
  crmExplorerAvailable,
  listCrmIdentityWindow,
} from "@/lib/data/crm-explorer";
import {
  CRM_DUPLICATE_ENTITY_TYPES,
  CRM_DUPLICATE_EVIDENCE_LABELS,
  listCrmDuplicateWindow,
} from "@/lib/data/crm-duplicate-review";
import { Card, CardBody, PageHeader, Pill } from "@/components/ui";
import { CrmProgressiveResults } from "@/components/crm/CrmProgressiveResults";
import { crmNavigationPage, crmNavigationParams, normalizeCrmNavigationFilters } from "@/components/crm/crm-navigation-query";
import { flagPossibleContactDuplicate, flagPossibleHouseholdDuplicate } from "./actions";
import styles from "./page.module.css";

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

const FLAG_MESSAGES: Record<string, string> = {
  invalid: "Enter two different 15- or 18-character CRM household IDs.",
  not_found: "One or both IDs do not match an active CRM household in AOA.",
  canonicalized_source: "One ID already redirects to a preserved household. Use that preserved CRM ID instead.",
  forbidden: "Your role cannot flag duplicate households.",
};

const CONTACT_FLAG_MESSAGES: Record<string, string> = {
  invalid: "Enter two different 15- or 18-character CRM contact IDs beginning with 003.",
  not_found: "One or both IDs do not match an active CRM contact in AOA.",
  different_household: "These contacts do not belong to the same canonical AOA household.",
  canonicalized_source: "One ID already redirects to a preserved contact. Use that preserved CRM ID instead.",
  forbidden: "Your role cannot flag duplicate contacts.",
};

export default async function CrmExplorerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!crmExplorerAvailable(role)) notFound();

  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["q", "type", "state", "exceptions", "duplicates"]) {
    const value = one(sp[key]);
    if (value) params.set(key, value);
  }
  const filters = normalizeCrmNavigationFilters(params);
  const flagMessage = one(sp.flagMessage);
  const contactFlagMessage = one(sp.contactFlagMessage);
  const identity = { role, email: session.user.email ?? null };
  const page = crmNavigationPage(one(sp.page));
  const window = { firstPage: page, pageSize: 100, loaded: 0, snapshot: null };
  const result = filters.duplicateView
    ? await listCrmDuplicateWindow(identity, filters.duplicateView, filters.type || null, window)
    : await listCrmIdentityWindow(identity, {
        q: filters.query, type: filters.type, state: filters.state,
        exceptionsOnly: filters.exceptionsOnly, page,
      }, window);
  if (!result.ok) notFound();
  // Numbered entry URLs remain supported, but an invalid page gets a useful
  // canonical first page instead of an empty table with misleading totals.
  if (result.firstPage > result.meta.pageCount) {
    const normalized = crmNavigationParams(filters).toString();
    redirect(normalized ? `/crm?${normalized}` : "/crm");
  }
  const initialPage = {
    rows: result.rows, firstPage: result.firstPage, pageSize: result.pageSize,
    loaded: result.loaded, hasMore: result.hasMore, snapshot: result.snapshot, meta: result.meta,
  };

  return (
    <>
      <PageHeader
        eyebrow="Admin · CRM relationship layer"
        title="CRM Explorer"
        description="Canonical CRM IDs, their existing system aliases, source freshness, and the links that connect each record. Visible to Operations and Admins only."
        actions={(
          <>
          <CrmExplorerLink href="/crm/employees" className="btn">Employee roster</CrmExplorerLink>
          <CrmExplorerLink href="/crm/schwab" className="btn">Schwab mappings</CrmExplorerLink>
          <Pill tone="green" dot>Identity reads on</Pill>
          </>
        )}
      />

      <CrmProgressiveResults
        key={crmNavigationParams(filters).toString() + ":" + initialPage.firstPage + ":" + initialPage.snapshot}
        initialPage={initialPage}
        scope={session.navigationScope ?? ""}
        filters={filters}
        identityTypes={CRM_EXPLORER_TYPES}
        duplicateTypes={CRM_DUPLICATE_ENTITY_TYPES}
        evidenceLabels={CRM_DUPLICATE_EVIDENCE_LABELS}
      >
      <Card id="flag-duplicate" className={styles.sectionCard}>
        <details className={styles.manualDuplicateDisclosure} data-crm-disclosure="flag-household" data-validation-open={Boolean(FLAG_MESSAGES[flagMessage])} open={Boolean(FLAG_MESSAGES[flagMessage])}>
          <summary className={`${styles.cardHeader} ${styles.manualDuplicateSummary}`}>
            <div>
              <h2>Flag a possible duplicate</h2>
              <p className={styles.cardHint}>
                Add two active CRM household IDs to the existing comparison and review workflow.
              </p>
            </div>
            <span className={styles.manualDuplicateSummaryMeta}>
              <Pill tone="gray">Operations review only</Pill>
              <span className={styles.disclosureChevron} aria-hidden="true">⌄</span>
            </span>
          </summary>
          <CardBody>
          {FLAG_MESSAGES[flagMessage] && (
            <p className={styles.errorAlert} role="alert">{FLAG_MESSAGES[flagMessage]}</p>
          )}
          <form action={flagPossibleHouseholdDuplicate} className={styles.manualDuplicateForm}>
            <label>
              First CRM household ID
              <input
                name="leftCrmId"
                inputMode="text"
                autoComplete="off"
                minLength={15}
                maxLength={18}
                pattern="[A-Za-z0-9]{15}([A-Za-z0-9]{3})?"
                placeholder="001…"
                required
              />
            </label>
            <span className={styles.duplicateVs} aria-hidden="true">compared with</span>
            <label>
              Second CRM household ID
              <input
                name="rightCrmId"
                inputMode="text"
                autoComplete="off"
                minLength={15}
                maxLength={18}
                pattern="[A-Za-z0-9]{15}([A-Za-z0-9]{3})?"
                placeholder="001…"
                required
              />
            </label>
            <button type="submit" className="btn">Compare records</button>
          </form>
          <p className={styles.manualDuplicateHint}>
            This only opens a review. It does not merge, delete, or change either CRM record.
          </p>
          </CardBody>
        </details>
      </Card>

      <Card id="flag-contact-duplicate" className={styles.sectionCard}>
        <details className={styles.manualDuplicateDisclosure} data-crm-disclosure="flag-contact" data-validation-open={Boolean(CONTACT_FLAG_MESSAGES[contactFlagMessage])} open={Boolean(CONTACT_FLAG_MESSAGES[contactFlagMessage])}>
          <summary className={`${styles.cardHeader} ${styles.manualDuplicateSummary}`}>
            <div>
              <h2>Compare possible duplicate contacts</h2>
              <p className={styles.cardHint}>
                Use two active CRM contact IDs when names differ but Operations has verified they are the same person.
              </p>
            </div>
            <span className={styles.manualDuplicateSummaryMeta}>
              <Pill tone="gray">Same household only</Pill>
              <span className={styles.disclosureChevron} aria-hidden="true">⌄</span>
            </span>
          </summary>
          <CardBody>
          {CONTACT_FLAG_MESSAGES[contactFlagMessage] && (
            <p className={styles.errorAlert} role="alert">{CONTACT_FLAG_MESSAGES[contactFlagMessage]}</p>
          )}
          <form action={flagPossibleContactDuplicate} className={styles.manualDuplicateForm}>
            <label>
              First CRM contact ID
              <input
                name="leftCrmId"
                inputMode="text"
                autoComplete="off"
                minLength={15}
                maxLength={18}
                pattern="003[A-Za-z0-9]{12}([A-Za-z0-9]{3})?"
                placeholder="003…"
                required
              />
            </label>
            <span className={styles.duplicateVs} aria-hidden="true">compared with</span>
            <label>
              Second CRM contact ID
              <input
                name="rightCrmId"
                inputMode="text"
                autoComplete="off"
                minLength={15}
                maxLength={18}
                pattern="003[A-Za-z0-9]{12}([A-Za-z0-9]{3})?"
                placeholder="003…"
                required
              />
            </label>
            <button type="submit" className="btn">Compare contacts</button>
          </form>
          <p className={styles.manualDuplicateHint}>
            This opens the existing reversible AOA review. It does not merge, delete, or change either CRM contact.
          </p>
          </CardBody>
        </details>
      </Card>

      </CrmProgressiveResults>
    </>
  );
}
