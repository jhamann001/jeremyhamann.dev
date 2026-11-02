"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  archiveTransfer, dismissSyncFlag, resumeDeferredTransfer, saveClientRequest, setAccountStatus,
} from "@/app/(authenticated)/asset-transfer/actions";
import { CLIENT_REQUEST_SOURCES } from "@/lib/transfers/client-request-sources";
import { easternToday } from "@/lib/transfers/eastern-day";
import { createTransferExceptionDecision } from "@/app/(authenticated)/(workflow)/decision-center/actions";
import { DECISION_OWNER_LABEL, DECISION_OWNER_TEAMS, type DecisionOwnerTeamValue } from "@/lib/data/decision-case-shared";
import { ResolveTransferException } from "@/components/asset-transfer/resolve/ResolveTransferException";
import type { TransferAccountRow, TransferAccountStatus } from "@/lib/data/transfer-types";
import type { ReconciledReceivingAccount } from "@/lib/transfers/connections";
import { Badge, btnClass } from "@/components/asset-transfer/workspace/ui";
import { WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";

type Failure = { ok: false; errors: { message: string }[] } | { ok: false; message: string };

function failureText(result: Failure): string {
  return "errors" in result ? result.errors[0]?.message ?? "This change could not be saved." : result.message;
}

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<Failure | { ok: true } | { ok: true; id: string } | void>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result && !result.ok) { setError(failureText(result)); return; }
      router.refresh();
      after?.();
    });
  };
  return { pending, error, run };
}

export function ResumeTransferButton({ transferId, disabled, title }: { transferId: string; disabled: boolean; title?: string }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <button type="button" className={btnClass({ primary: true, tiny: true })} data-ui="resume-transfer" disabled={disabled || pending} title={title}
        onClick={() => run(() => resumeDeferredTransfer(transferId))}>{pending ? "Resuming…" : "Resume transfer"}</button>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
    </>
  );
}

export function SyncFlagActions({ transferId, archiveEnabled }: { transferId: string; archiveEnabled: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className={btnClass({ tiny: true })} disabled={pending} onClick={() => run(() => dismissSyncFlag(transferId))}>Keep and dismiss</button>
        {archiveEnabled ? <button type="button" className={btnClass({ tiny: true, danger: true })} disabled={pending}
          onClick={() => run(() => archiveTransfer(transferId))}>Remove from the board</button> : null}
      </div>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
    </>
  );
}

export function ArchiveTransferButton({ transferId }: { transferId: string }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <button type="button" className={btnClass({ tiny: true, quiet: true })} disabled={pending} onClick={() => run(() => archiveTransfer(transferId))}>
        {pending ? "Removing…" : "Remove from the board"}
      </button>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
    </>
  );
}

export type ExceptionCase = {
  id: string;
  question: string;
  open: boolean;
  blocking: boolean;
  owner: string;
  resolution: string | null;
  version: number;
};

export function TransferExceptions({ transferId, cases, canWrite }: { transferId: string; cases: ExceptionCase[]; canWrite: boolean }) {
  return (
    <>
      {cases.map(item => (
        <article className="followup-check" key={item.id}>
          <div className="followup-check-copy">
            <div className="followup-check-heading"><strong>{item.question}</strong>
              <Badge tone={item.open ? (item.blocking ? "blocked" : "waiting") : "completed"}>{item.open ? (item.blocking ? "Blocking" : "Open") : "Resolved"}</Badge>
            </div>
            <p>{item.open ? `${item.owner} owns the exception.` : item.resolution ?? "Resolved."}</p>
          </div>
          {item.open && item.blocking && canWrite ? (
            <div className="followup-check-actions">
              <ResolveTransferException decisionId={item.id} baseVersion={item.version} appearance="workspace" />
            </div>
          ) : null}
        </article>
      ))}
      <article className="followup-check">
        <div className="followup-check-copy">
          <div className="followup-check-heading"><strong>Transfer exceptions</strong>
            <Badge tone={cases.some(item => item.open) ? "waiting" : "neutral"}>{`${cases.filter(item => item.open).length} open`}</Badge></div>
          <p>Only issues that need clarification or a separate resolution. Known route rules stay in the approved funding plan.</p>
        </div>
        {canWrite ? <div className="followup-check-actions"><ExceptionDialog transferId={transferId} /></div> : null}
      </article>
    </>
  );
}

function ExceptionDialog({ transferId }: { transferId: string }) {
  return (
    <WorkspaceDialog title="Record a transfer exception" trigger="Record exception" triggerStyle={{ tiny: true }}>
      {close => <ExceptionForm transferId={transferId} close={close} />}
    </WorkspaceDialog>
  );
}

function ExceptionForm({ transferId, close }: { transferId: string; close: () => void }) {
  const { pending, error, run } = useAction();
  const [question, setQuestion] = useState("");
  const [ownerTeam, setOwnerTeam] = useState<DecisionOwnerTeamValue>("OPERATIONS");
  const [blocksTransfer, setBlocksTransfer] = useState(true);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() => createTransferExceptionDecision({ transferId, question, ownerTeam, blocksTransfer }), close);
  };
  return (
    <form onSubmit={submit}>
      <label className="field"><span>What needs a decision?</span>
        <textarea required maxLength={500} value={question} onChange={event => setQuestion(event.target.value)} />
      </label>
      <label className="field"><span>Owner</span>
        <select value={ownerTeam} onChange={event => setOwnerTeam(event.target.value as DecisionOwnerTeamValue)}>
          {DECISION_OWNER_TEAMS.map(team => <option key={team} value={team}>{DECISION_OWNER_LABEL[team]}</option>)}
        </select>
      </label>
      <label className="lifecycle-confirm"><input type="checkbox" checked={blocksTransfer} onChange={event => setBlocksTransfer(event.target.checked)} />
        <span>This blocks the transfer until it is resolved.</span></label>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Record exception"}</button>
        <button className="btn" type="button" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

export function ReceivingAccounts({ transferId, accounts, canWrite, reconciled }: {
  transferId: string; accounts: TransferAccountRow[]; canWrite: boolean;
  /** Each account read against the client's Apex accounts; an Apex-governed status cannot be toggled. */
  reconciled?: ReconciledReceivingAccount[];
}) {
  const { pending, error, run } = useAction();
  if (!accounts.length) return null;
  return (
    <div className="subtle" style={{ marginTop: 14 }}>
      <div className="kicker">Recorded receiving accounts</div>
      {accounts.map(account => {
        const match = reconciled?.find(item => item.id === account.id) ?? null;
        const status = match?.status ?? (account.status === "OPEN" ? "OPEN" : "TO_OPEN");
        const next: TransferAccountStatus = status === "OPEN" ? "TO_OPEN" : "OPEN";
        const governed = match?.source === "apex";
        return (
          <div className="row between" key={account.id} style={{ marginTop: 8 }}>
            <span>{account.label} · {status === "OPEN" ? "Open" : "To open"}
              {match ? <small data-testid="receiving-account-source">{governed
                ? ` · From Apex record${match.apexMasked ? ` ${match.apexMasked}` : ""}`
                : " · Manual · no matching Apex account"}</small> : null}
            </span>
            {canWrite && !governed ? <button type="button" className={btnClass({ tiny: true })} disabled={pending}
              onClick={() => run(() => setAccountStatus(transferId, account.id, next))}>{next === "OPEN" ? "Mark open" : "Mark to open"}</button> : null}
          </div>
        );
      })}
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** The mockup's "Record funding request" dialog: the date the client asked and where the request came from. */
export function ClientRequestDialog({ transferId, requestedOn, source, context }: {
  transferId: string; requestedOn: string | null; source: string | null; context?: ReactNode;
}) {
  return (
    <WorkspaceDialog title="Record funding request" trigger={requestedOn ? "Edit request" : "Record request"} triggerStyle={{ tiny: true }} context={context}>
      {close => <ClientRequestForm transferId={transferId} requestedOn={requestedOn} source={source} close={close} />}
    </WorkspaceDialog>
  );
}

function ClientRequestForm({ transferId, requestedOn, source, close }: {
  transferId: string; requestedOn: string | null; source: string | null; close: () => void;
}) {
  const { pending, error, run } = useAction();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    run(() => saveClientRequest(transferId, { requestedOn: String(data.get("date") ?? ""), source: String(data.get("source") ?? "") }), close);
  };
  return (
    <form id="client-request-form" onSubmit={submit}>
      <p>Record a request you have already received. Use the date the client made the request; the time you record it is saved automatically.</p>
      <div className="twocol">
        <label className="field"><span>Client request date</span>
          <input name="date" type="date" required defaultValue={requestedOn ?? easternToday()} max={easternToday()} />
        </label>
        <label className="field"><span>Request source</span>
          <select name="source" required defaultValue={source ?? CLIENT_REQUEST_SOURCES[0]}>
            {CLIENT_REQUEST_SOURCES.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
      <div className="row">
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save request"}</button>
        <button className="btn" type="button" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}
