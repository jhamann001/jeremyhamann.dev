import { CrmPreviewNotice } from "@/components/crm/CrmPreviewNotice";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader, FieldList, Pill } from "@/components/ui";
import type {
  AccountTradeRequestProfile,
  TradeProfileAccountWarning,
  TradeProfileSource,
  TradeRequestProfile,
} from "@/lib/data/trade-request-profile";
import { RiskGauge } from "./RiskGauge";
import styles from "./TradeRequestProfileCards.module.css";

const datePart = (iso: string): string => iso.slice(0, 10);

function ProfileStatePill({ state }: { state: TradeRequestProfile["state"] }) {
  if (state === "ready") return <Pill tone="green">Approved source</Pill>;
  if (state === "conflict") return <Pill tone="amber">Needs review</Pill>;
  if (state === "account_variation") {
    return <Pill tone="gold">Varies by account</Pill>;
  }
  if (state === "account_review") return <Pill tone="amber">Account review</Pill>;
  if (state === "household_review") return <Pill tone="gold">Scope review</Pill>;
  return <Pill tone="gray">No approved data</Pill>;
}

function SourceLine({ source }: { source: TradeProfileSource }) {
  return (
    <li>
      <code>{source.requestId}</code>
      <span>
        {source.status} {source.tradeType} · {datePart(source.decidedAt)}
        {source.scope === "household" ? " · household scope" : ""}
      </span>
    </li>
  );
}

function Sources({ profile }: { profile: TradeRequestProfile }) {
  if (profile.sources.length === 0 && profile.excludedRequestCount === 0) return null;
  return (
    <div className={styles.sources}>
      {profile.sources.length > 0 ? (
        <>
          <strong>Qualifying source{profile.sources.length === 1 ? "" : "s"}</strong>
          <ul>
            {profile.sources.map((source) => (
              <SourceLine key={source.requestId} source={source} />
            ))}
          </ul>
        </>
      ) : null}
      {profile.excludedRequestCount > 0 ? (
        <p>
          {profile.excludedRequestCount} pending, rejected, or non-allocation request
          {profile.excludedRequestCount === 1 ? " was" : "s were"} excluded.
        </p>
      ) : null}
    </div>
  );
}

function InstructionEmptyMessage({ profile }: { profile: TradeRequestProfile }) {
  if (profile.state === "household_review") {
    return (
      <div className={styles.reviewMessage}>
        <strong>Client-level scope is not established.</strong>
        <p>
          An approved household request includes this client, but its risk score and
          instructions are not automatically assigned to an individual. Review the
          household intent first.
        </p>
      </div>
    );
  }
  return (
    <div className={styles.emptyMessage}>
      <strong>No approved investment instructions on file.</strong>
      <p>
        Only approved or completed Initial Funding and Rebalance requests may populate
        these fields.
      </p>
    </div>
  );
}

function RiskEmptyMessage({ profile }: { profile: TradeRequestProfile }) {
  if (profile.state === "household_review") {
    return <InstructionEmptyMessage profile={profile} />;
  }
  return (
    <div className={styles.emptyMessage}>
      <strong>No approved risk score on file.</strong>
      <p>
        Pending, rejected, and non-allocation requests cannot supply the client risk
        score.
      </p>
    </div>
  );
}

function ScopeReviewMessage() {
  return (
    <p className={styles.accountEmpty}>
      An approved request for this account also includes another household member.
      Its risk score and instructions apply only after a reviewer confirms it for this
      account.
    </p>
  );
}

function InstructionFields({ account }: { account: AccountTradeRequestProfile }) {
  if (account.state === "scope_review") return <ScopeReviewMessage />;
  if (account.state === "missing") {
    return (
      <p className={styles.accountEmpty}>
        No approved Initial Funding or Rebalance request was found for this active
        account.
      </p>
    );
  }

  return (
    <>
      {account.state === "conflict" ? (
        <p className={styles.accountWarning}>
          Contradictory approved instructions were found for this account.
        </p>
      ) : null}
      {account.instructions.length > 0 ? (
        <FieldList
          items={account.instructions.map((instruction) => ({
            label: instruction.label,
            value: (
              <span>
                {instruction.value}
                <small className={styles.provenance}>
                  {instruction.sourceRequestId} · {datePart(instruction.decidedAt)}
                </small>
              </span>
            ),
          }))}
        />
      ) : null}
      {account.instructionConflicts.map((conflict) => (
        <div className={styles.accountConflict} key={conflict.key}>
          <strong>{conflict.label}</strong>
          <ul>
            {conflict.options.map((option) => (
              <li key={option.sourceRequestId + "-" + option.value}>
                {option.value} · {option.sourceRequestId}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function AccountHeading({ account }: { account: AccountTradeRequestProfile }) {
  return (
    <div className={styles.accountHeader}>
      <div>
        <strong>{account.accountType ?? "Account"}</strong>
        <span>{account.accountNumber}</span>
      </div>
      {account.state === "ready" ? (
        <Pill tone="green">Matched</Pill>
      ) : account.state === "conflict" ? (
        <Pill tone="amber">Conflict</Pill>
      ) : account.state === "scope_review" ? (
        <Pill tone="gold">Scope review</Pill>
      ) : (
        <Pill tone="gray">Missing</Pill>
      )}
    </div>
  );
}

function AccountInstructions({ profile }: { profile: TradeRequestProfile }) {
  const review = profile.accountReview;
  if (!review) return null;
  return (
    <div className={styles.accountList}>
      {review.accounts.map((account) => (
        <section className={styles.accountPanel} key={account.accountId}>
          <AccountHeading account={account} />
          <InstructionFields account={account} />
        </section>
      ))}
    </div>
  );
}

function AccountRisks({ profile }: { profile: TradeRequestProfile }) {
  const review = profile.accountReview;
  if (!review) return null;
  return (
    <div className={styles.accountList}>
      {review.accounts.map((account) => (
        <section className={styles.accountPanel} key={account.accountId}>
          <AccountHeading account={account} />
          {account.risk ? (
            <>
              <RiskGauge risk={account.risk.profile} />
              <p className={styles.riskSource}>
                Source <code>{account.risk.sourceRequestId}</code> · approved{" "}
                {datePart(account.risk.decidedAt)}
              </p>
            </>
          ) : account.state === "scope_review" ? (
            <ScopeReviewMessage />
          ) : (
            <p className={styles.accountEmpty}>
              No approved risk score was found for this account.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

function warningText(warning: TradeProfileAccountWarning): string {
  if (warning.kind === "missing_request_scope") {
    return `${warning.requestId} does not include a stable account identifier.`;
  }
  if (warning.kind === "inactive_request_account") {
    return `${warning.requestId} references inactive account ${warning.accountNumber ?? "unavailable"}.`;
  }
  return `${warning.requestId} references account ${warning.accountNumber ?? "unavailable"}, which could not be matched to this client.`;
}

function AccountReviewNotice({ profile }: { profile: TradeRequestProfile }) {
  const review = profile.accountReview;
  if (!review || review.state === "consistent") return null;
  return (
    <div className={styles.reviewMessage}>
      <strong>
        {review.state === "varies"
          ? "Investment profile varies by account."
          : "Account-level review is required."}
      </strong>
      <p>
        {review.state === "varies"
          ? `The approved instructions${review.riskVaries ? " and risk scores" : ""} are not the same across every active account. Review each account below.`
          : "At least one active account is missing a qualifying request, contains a conflict, has a household request awaiting confirmation, or could not be matched exactly."}
      </p>
      {review.warnings.length > 0 ? (
        <ul className={styles.warningList}>
          {review.warnings.map((warning) => (
            <li key={`${warning.kind}-${warning.requestId}-${warning.accountNumber ?? ""}`}>
              {warningText(warning)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TradeRequestProfileCards({
  profile,
  source = "synthetic",
  reviewControls,
}: {
  profile: TradeRequestProfile;
  source?: "synthetic" | "live";
  reviewControls?: ReactNode;
}) {
  const unavailable =
    profile.state === "none" || profile.state === "household_review";
  const accountScoped =
    profile.state === "account_variation" || profile.state === "account_review";

  return (
    <section className={styles.section} aria-label="Trade Request investment profile preview">
      {source === "synthetic" ? (
        <CrmPreviewNotice>
          This preview applies the proposed approval, scope, and conflict rules to
          synthetic Trade Request records. Each development client receives a stable
          review scenario; no production Trade Request data is read.
        </CrmPreviewNotice>
      ) : null}

      <div className={styles.grid}>
        <Card>
          <CardHeader className={styles.header}>
            <div>
              <span className={styles.eyebrow}>Trade Request-derived</span>
              <h2>Investment instructions</h2>
            </div>
            <ProfileStatePill state={profile.state} />
          </CardHeader>
          <CardBody>
            <AccountReviewNotice profile={profile} />
            {unavailable ? <InstructionEmptyMessage profile={profile} /> : null}

            {accountScoped ? <AccountInstructions profile={profile} /> : null}

            {!accountScoped && profile.state === "conflict" ? (
              <div className={styles.reviewMessage}>
                <strong>Contradictory approved instructions found.</strong>
                <p>
                  Conflicting values remain unresolved until a reviewer confirms which
                  request supersedes the other.
                </p>
              </div>
            ) : null}

            {!accountScoped && profile.instructions.length > 0 ? (
              <FieldList
                items={profile.instructions.map((instruction) => ({
                  label: instruction.label,
                  value: (
                    <span>
                      {instruction.value}
                      <small className={styles.provenance}>
                        {instruction.sourceRequestId} · {datePart(instruction.decidedAt)}
                      </small>
                    </span>
                  ),
                }))}
              />
            ) : null}

            {!accountScoped &&
            !unavailable &&
            profile.instructions.length === 0 &&
            profile.instructionConflicts.length === 0 ? (
              <InstructionEmptyMessage profile={profile} />
            ) : null}

            {profile.instructionConflicts.length > 0 ? (
              <div className={styles.conflicts}>
                {profile.instructionConflicts.map((conflict) => (
                  <div className={styles.conflict} key={conflict.key}>
                    <strong>{conflict.label}</strong>
                    <ul>
                      {conflict.options.map((option) => (
                        <li key={option.sourceRequestId + "-" + option.value}>
                          <span>{option.value}</span>
                          <small>
                            {option.sourceRequestId} · {datePart(option.decidedAt)}
                          </small>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}

            <Sources profile={profile} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader className={styles.header}>
            <div>
              <span className={styles.eyebrow}>Trade Request-derived</span>
              <h2>Risk profile</h2>
            </div>
            <ProfileStatePill state={profile.risk ? "ready" : profile.state} />
          </CardHeader>
          <CardBody>
            {accountScoped ? (
              <>
                <AccountReviewNotice profile={profile} />
                <AccountRisks profile={profile} />
              </>
            ) : profile.risk ? (
              <>
                <RiskGauge risk={profile.risk.profile} />
                <p className={styles.riskSource}>
                  Source <code>{profile.risk.sourceRequestId}</code> · approved{" "}
                  {datePart(profile.risk.decidedAt)}
                  {profile.risk.previousScore != null
                    ? " · prior approved score " + profile.risk.previousScore
                    : ""}
                </p>
              </>
            ) : (
              <RiskEmptyMessage profile={profile} />
            )}
          </CardBody>
        </Card>
      </div>
      {reviewControls}
    </section>
  );
}
