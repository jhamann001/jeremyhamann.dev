import { useState } from "react";
import type { AssetMapAccountView } from "@/lib/data/asset-map";
import type { AssetMapDestination } from "@/lib/data/asset-map-destinations";
import { Button, Card, CardBody, CardHeader } from "@/components/ui";
import { EditFailureText } from "../edits/EditFeedback";
import {
  DESTINATION_COPY as C, DESTINATION_TYPES, NEW_DESTINATION_TYPE, NEW_DESTINATION_VALUE,
  destinationCountLine, destinationLabel, destinationTag, destinationTypeOptions, fedByText,
  sourceForAccount, suggestionText, type DestinationIntent, type DestinationState,
} from "./destination-model";
import styles from "../AssetMappingWorkspace.module.css";

type Common = { state: DestinationState; onSave: (intent: DestinationIntent) => void };

function Saving() {
  return <span className={styles.muted} aria-busy="true">{C.saving}</span>;
}

function Failure({ state, keyName }: { state: DestinationState; keyName: string }) {
  return state.failure?.key === keyName ? <EditFailureText text={state.failure.text} /> : null;
}

function DestinationRow({ d, others, state, onSave }: Common & { d: AssetMapDestination; others: AssetMapDestination[] }) {
  const typeKey = `type:${d.id}`;
  const needsKey = `needsOpen:${d.id}`;
  const removeKey = `remove:${d.id}`;
  const suggestion = suggestionText(d);
  return (
    <div className={styles.destinationRow}>
      <div className={styles.editRow}>
        <strong>{`${d.owner || "—"} ·`}</strong>
        {state.pending.includes(typeKey) ? <Saving /> : (
          <select
            aria-label={C.typeLabel}
            className={styles.editSelect}
            value={d.targetAccountType ?? ""}
            onChange={(e) => { if (e.target.value !== d.targetAccountType) onSave({ kind: "type", targetId: d.id, targetAccountType: e.target.value }); }}
          >
            {destinationTypeOptions(d.targetAccountType).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <span className={styles.muted}>{destinationTag(d)}</span>
        {state.pending.includes(needsKey) ? <Saving /> : (
          <select
            aria-label={C.needsLabel}
            className={styles.editSelect}
            value={d.needsToBeOpened ? "yes" : "no"}
            onChange={(e) => { const needs = e.target.value === "yes"; if (needs !== d.needsToBeOpened) onSave({ kind: "needsOpen", targetId: d.id, needsToBeOpened: needs }); }}
          >
            <option value="yes">{C.needsYes}</option>
            <option value="no">{C.needsNo}</option>
          </select>
        )}
        <Failure state={state} keyName={typeKey} />
        <Failure state={state} keyName={needsKey} />
      </div>
      <div className={styles.suggestion}>{suggestion.text}</div>
      <div className={styles.muted}>{fedByText(d.sources.length)}</div>
      <div className={styles.badges}>
        {d.sources.map((s) => {
          const moveKey = `reassign:${s.linkId}`;
          return (
            <span key={s.linkId} className={styles.sourceChip}>
              <span>{s.custodian || "—"}</span>
              <span className={styles.muted}>{s.accountNumberMasked ?? ""}</span>
              {state.pending.includes(moveKey) ? <Saving /> : (
                <select
                  aria-label={C.moveLabel}
                  className={styles.editSelect}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === NEW_DESTINATION_VALUE) onSave({ kind: "reassignNew", linkId: s.linkId, newOwner: d.owner });
                    else if (v !== "") onSave({ kind: "reassign", linkId: s.linkId, targetAccountId: v });
                  }}
                >
                  <option value="">{C.movePlaceholder}</option>
                  {others.map((o) => <option key={o.id} value={o.id}>{destinationLabel(o, false)}</option>)}
                  <option value={NEW_DESTINATION_VALUE}>{C.newAccount}</option>
                </select>
              )}
              <Failure state={state} keyName={moveKey} />
            </span>
          );
        })}
      </div>
      <div className={styles.editRow}>
        {state.pending.includes(removeKey) ? <Saving /> : (
          <Button size="sm" variant="ghost" onClick={() => onSave({ kind: "remove", targetId: d.id })}>{C.remove}</Button>
        )}
        <Failure state={state} keyName={removeKey} />
      </div>
    </div>
  );
}

export function DestinationsPanel({ state, onSave, onRetry, defaultAdding }: Common & { onRetry: () => void; defaultAdding?: boolean }) {
  const [adding, setAdding] = useState(defaultAdding ?? false);
  const [owner, setOwner] = useState("");
  const [type, setType] = useState<string>(NEW_DESTINATION_TYPE);
  if (state.status === "failed") {
    return (
      <Card>
        <CardHeader>{C.heading}</CardHeader>
        <CardBody>
          <p className={styles.notice}>{C.loadFailed}</p>
          <Button size="sm" variant="ghost" onClick={onRetry}>{C.retry}</Button>
        </CardBody>
      </Card>
    );
  }
  if (state.view == null) {
    return (
      <Card>
        <CardHeader>{C.heading}</CardHeader>
        <CardBody><p className={styles.muted} aria-busy="true">{C.loading}</p></CardBody>
      </Card>
    );
  }
  const list = state.view.destinations;
  return (
    <details className={styles.disclosure} data-section="destinations">
      <summary className={styles.disclosureSummary}>
        <strong>{C.heading}</strong>
        <span className={styles.muted}>{destinationCountLine(list)}</span>
      </summary>
      <div className={styles.disclosureBody}>
        <div className={styles.destinationHead}>
          <span className={styles.muted}>{C.suggestionNote}</span>
          {state.pending.includes("add") ? <Saving /> : (
            <Button size="sm" variant="ghost" onClick={() => setAdding((a) => !a)}>{C.addNew}</Button>
          )}
        </div>
        {adding ? (
          <form
            className={styles.editRow}
            onSubmit={(e) => {
              e.preventDefault();
              onSave({ kind: "add", owner, targetAccountType: type });
              setAdding(false);
              setOwner("");
            }}
          >
            <input aria-label={C.ownerPlaceholder} placeholder={C.ownerPlaceholder} className={styles.editSelect} value={owner} onChange={(e) => setOwner(e.target.value)} />
            <select aria-label={C.newTypeLabel} className={styles.editSelect} value={type} onChange={(e) => setType(e.target.value)}>
              {DESTINATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <Button size="sm" type="submit">{C.add}</Button>
          </form>
        ) : null}
        <Failure state={state} keyName="add" />
        {list.length === 0 ? <p className={styles.muted}>{C.empty}</p> : list.map((d) => (
          <DestinationRow key={d.id} d={d} others={list.filter((o) => o.id !== d.id)} state={state} onSave={onSave} />
        ))}
      </div>
    </details>
  );
}

export function TransferTargetControl({ account, state, onSave }: Common & { account: AssetMapAccountView }) {
  const link = sourceForAccount(state.view, account.id);
  if (!link || !state.view) return null;
  const key = `reassign:${link.linkId}`;
  return (
    <div className={styles.editRow}>
      <span className={styles.muted}>{C.transfersTo}</span>
      {state.pending.includes(key) ? <Saving /> : (
        <select
          aria-label={C.transfersTo}
          className={styles.editSelect}
          value={link.destination.id}
          onChange={(e) => {
            const v = e.target.value;
            if (v === NEW_DESTINATION_VALUE) onSave({ kind: "reassignNew", linkId: link.linkId, newOwner: link.destination.owner });
            else if (v !== link.destination.id) onSave({ kind: "reassign", linkId: link.linkId, targetAccountId: v });
          }}
        >
          {state.view.destinations.map((o) => <option key={o.id} value={o.id}>{destinationLabel(o, true)}</option>)}
          <option value={NEW_DESTINATION_VALUE}>{C.newAccount}</option>
        </select>
      )}
      <Failure state={state} keyName={key} />
    </div>
  );
}

export function ExportCsvButton({ ready, onExport }: { ready: boolean; onExport: () => void }) {
  return <Button variant="ghost" size="sm" disabled={!ready} onClick={onExport}>{C.exportCsv}</Button>;
}
