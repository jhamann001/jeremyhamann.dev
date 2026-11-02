import { withUserScope, type Identity } from "@/lib/rls";
import { transferToFormValues } from "@/components/transfers/transfer-form";
import type { TransferAccountRow, TransferRow } from "@/lib/data/transfer-types";
import { updateTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import {
  accountTypesAgree,
  receivingStillOpening,
  statementBlocks,
  useReceivingAccountAsDestination as receivingDestinationChoice,
} from "@/lib/transfers/intake-gates";
import { canWriteTransfers } from "@/lib/data/transfer-write";
import { readStatementRecords } from "@/lib/data/transfer-statement-documents";
import { outcomeRecordsEnabled, preparationPausedFor } from "@/lib/transfers/outcomes";
import {
  STATEMENT_MESSAGES,
  currentStatementSummary,
  deliveringStatementLine,
  statementButtonLabel,
  statementCheckHelp,
  statementCheckTitle,
  statementDialogTitle,
  statementIssueLabel,
} from "@/lib/transfers/statement-document";
import { cx, type BadgeTone } from "@/components/asset-transfer/workspace/ui";
import { FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { AccountTypesDialog, StatementDialog, type IntakeFormState } from "./IntakeDialogs";

const ACCOUNT_TYPES = [
  "Individual",
  "Joint",
  "Traditional IRA",
  "Roth IRA",
  "Rollover IRA",
  "SEP IRA",
  "Inherited IRA",
  "Trust",
  "Custodial",
  "Corporate",
] as const;

export type TransferContext = { title: string; detail: string };

async function loadIntake(identity: Identity, transferId: string) {
  return withUserScope(identity, async (tx) => {
    const [statements, match, submission, paused] = await Promise.all([
      readStatementRecords(tx, transferId),
      tx.transferAccountMatch.findFirst({
        where: { transfer_id: transferId },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: { delivering_account_type: true, receiving_account_type: true, created_at: true },
      }),
      tx.transferSubmission.findFirst({ where: { transfer_id: transferId }, select: { id: true } }),
      preparationPausedFor(tx, transferId, outcomeRecordsEnabled()),
    ]);
    const statement = statements.latest.provided ? { accepted: statements.latest.accepted } : null;
    return { statements, statement, match, submitted: submission != null, paused };
  });
}

type Intake = Awaited<ReturnType<typeof loadIntake>>;

function destinationNote(account: TransferAccountRow): string {
  const choice = receivingDestinationChoice(account.id, account.status);
  return choice.ok ? "Opened. It can be the destination." : choice.message;
}

function intakeStatus({ statements, statement, match }: Intake): { tone: BadgeTone; label: string; open: boolean } {
  const typesAgree = accountTypesAgree(match?.delivering_account_type, match?.receiving_account_type);
  if (statementBlocks(true, statement)) {
    return { tone: "blocked", label: statementIssueLabel(statements.latest) ?? "Current statement needed", open: true };
  }
  if (match == null) return { tone: "waiting", label: "Account types not recorded", open: true };
  return typesAgree
    ? { tone: "completed", label: "Statement accepted · types match", open: false }
    : { tone: "blocked", label: "Statement accepted · types differ", open: true };
}

/** Section-header status for the workflow section that mounts `StatementAccountSection`. */
export async function statementAccountStatus(identity: Identity, transferId: string) {
  return intakeStatus(await loadIntake(identity, transferId));
}

function Check({ ok, title, help, gate }: { ok: boolean; title: string; help: string; gate?: string }) {
  return (
    <div className={cx("check", !ok && "bad")} data-gate={gate}>
      {ok ? "✓" : "!"} {title}<small>{help}</small>
    </div>
  );
}

function errorsOf(result: Awaited<ReturnType<typeof updateTransfer>>): IntakeFormState {
  if (result && !result.ok) return { errors: result.errors.map((error) => error.message) };
  return { errors: [], saved: Date.now() };
}

function lastFour(value: string | null): string {
  return (value ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(-4);
}

/** ATW-02 statement and account checks: the body of the "Statement & account checks" section. */
export async function StatementAccountSection({
  identity,
  transfer,
  accounts,
  canRecord,
  transferContext,
  bare = false,
}: {
  identity: Identity;
  transfer: TransferRow;
  accounts: TransferAccountRow[];
  canRecord: boolean;
  transferContext?: TransferContext;
  bare?: boolean;
}) {
  const intake = await loadIntake(identity, transfer.id);
  const { statements, statement, match, submitted, paused } = intake;
  const view = statements.latest;
  const blocked = statementBlocks(true, statement);
  const typesAgree = accountTypesAgree(match?.delivering_account_type, match?.receiving_account_type);
  const stillOpening = receivingStillOpening(accounts);
  const transferId = transfer.id;
  const values = transferToFormValues(transfer);
  const context = transferContext ? <FormTransferContext title={transferContext.title} detail={transferContext.detail} /> : undefined;
  const canDownload = canWriteTransfers(identity.role);
  const downloadHref = (documentId: string) =>
    `/api/asset-transfer/${encodeURIComponent(transferId)}/statements/${encodeURIComponent(documentId)}`;

  async function recordAccountTypes(_previous: IntakeFormState, formData: FormData): Promise<IntakeFormState> {
    "use server";
    return errorsOf(await updateTransfer(transferId, values, {
      deliveringAccountType: String(formData.get("delivering") ?? ""),
      receivingAccountType: String(formData.get("receiving") ?? ""),
    }));
  }

  const suffix = lastFour(transfer.asset_map_account_number);
  const deliveringType = match?.delivering_account_type ?? transfer.asset_map_account_type;
  const institution = transfer.transferring_firm?.trim() || "Delivering firm not recorded";
  const sourceDetail = [institution, `${deliveringType ?? "Account type not recorded"}${suffix ? ` •••• ${suffix}` : ""}`].join(" · ");
  const lockedReason = submitted ? STATEMENT_MESSAGES.submitted : paused ? STATEMENT_MESSAGES.paused : undefined;
  const latestFile = statements.latestFile;

  const body = (
    <>
      <div className="workflow-source row"><span className="source-label">Asset Transfer intake</span></div>
      <div className="twocol">
        <div className="account" aria-label="Delivering account">
          <div className="kicker">Delivering account</div>
          <strong>{institution}</strong>
          <p>{deliveringType ?? "Account type not recorded"}{suffix ? ` •••• ${suffix}` : ""}</p>
          <p>{deliveringStatementLine(view)}</p>
          {latestFile && (
            <p className="statement-filename">
              {canDownload ? <a href={downloadHref(latestFile.id)} download>{latestFile.filename}</a> : latestFile.filename}
            </p>
          )}
        </div>
        <div className="account" aria-label="Receiving accounts">
          <div className="kicker">Receiving account · Apex</div>
          {accounts.length === 0 ? (
            <p>No receiving accounts recorded on this movement.</p>
          ) : (
            accounts.map((account) => (
              <div key={account.id} data-account-status={account.status}>
                <strong>{account.label}</strong>
                <p>{destinationNote(account)}</p>
              </div>
            ))
          )}
          {match?.receiving_account_type && <p>Recorded type: {match.receiving_account_type}</p>}
          {stillOpening && <p className="small">Record the account as opened before using it as the destination.</p>}
          {canRecord && (
            <AccountTypesDialog
              action={recordAccountTypes}
              version={match?.created_at.toISOString() ?? "none"}
              delivering={match?.delivering_account_type ?? transfer.asset_map_account_type ?? ""}
              receiving={match?.receiving_account_type ?? ""}
              accountTypes={ACCOUNT_TYPES}
              context={context}
            />
          )}
        </div>
      </div>
      <div className="checks">
        <Check
          ok={!blocked}
          title={statementCheckTitle(view)}
          help={statementCheckHelp(view)}
          gate={blocked ? "statement" : undefined}
        />
        <Check
          ok={match != null && typesAgree}
          title={match == null
            ? "Account types not recorded — needs attention"
            : typesAgree ? "Account types match" : "Account types differ — needs attention"}
          help={match != null && !typesAgree
            ? "Full ACAT and Partial ACAT cannot proceed until the types match. Manual needs the titles section completed. DRS, Rollover, ACH, and Wire do not require a match."
            : match == null
              ? "Record the delivering and receiving account types."
              : `${match.delivering_account_type} → ${match.receiving_account_type}. Rechecks when either type changes.`}
          gate={match != null && !typesAgree ? "account-match" : undefined}
        />
        <Check
          ok={accounts.length > 0 && !stillOpening}
          title={accounts.length === 0
            ? "No receiving account — needs attention"
            : stillOpening ? "Receiving account still opening — needs attention" : "Receiving account opened"}
          help={stillOpening
            ? "Record the account as opened before using it as the destination."
            : accounts.length === 0 ? "Add the receiving account on the movement." : "It can be the destination."}
        />
      </div>
      {canRecord && (
        <div className="row" style={{ marginTop: 17 }}>
          <StatementDialog
            transferId={transferId}
            version={statements.version}
            title={statementDialogTitle(view)}
            trigger={statementButtonLabel(view)}
            triggerDisabled={lockedReason != null}
            triggerTitle={lockedReason}
            source={{ client: `${transfer.client_first_name} ${transfer.client_last_name}`.trim(), detail: sourceDetail }}
            current={currentStatementSummary(view)}
            provided={view.provided}
            pending={statements.pendingFile
              ? {
                  id: statements.pendingFile.id,
                  filename: statements.pendingFile.filename,
                  byteSize: statements.pendingFile.byteSize,
                  statementDate: statements.pendingFile.statementDate,
                }
              : null}
          />
        </div>
      )}
      <p className="small" style={{ marginTop: 10 }}>
        An updated statement reopens the affected funding plan approval. Investment instructions and other independent work remain intact.
      </p>
      {statements.previous.length > 0 && (
        <details>
          <summary>Previous statements ({statements.previous.length})</summary>
          {statements.previous.map((file) => (
            <p key={file.id}>
              {canDownload ? <a href={downloadHref(file.id)} download>{file.filename}</a> : file.filename}
              {" · "}{file.statementDate ?? "date pending"} · Version {file.version}
            </p>
          ))}
        </details>
      )}
    </>
  );
  return bare ? body : <div className="sectionbody">{body}</div>;
}
