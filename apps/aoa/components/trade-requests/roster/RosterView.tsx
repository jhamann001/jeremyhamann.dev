"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Card, PageHeader } from "@/components/ui";
import { TradeRequestsSessionEnded } from "@/components/trade-requests/queue/SessionEndedNotice";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import { EMAIL_PATTERN, ROSTER_COPY, rosterRequest, type RosterChange, type RosterMember } from "@/lib/trade-requests/roster-view";
import styles from "../drift/Drift.module.css";

// The ADMIN-only trader roster (ticket): list, add by email, remove and Slack member ID, each with the
// member's eligibility. The Slack edit keeps the standalone Users tab behaviour (UsersTab.tsx:123-156):
// Enter or leaving the field saves, Escape cancels.
export function RosterView() {
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [editingSlack, setEditingSlack] = useState<string | null>(null);
  const [slackInput, setSlackInput] = useState("");
  const savingSlackRef = useRef(false);
  const slackCancelledRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await rosterRequest();
    if (!mountedRef.current) return;
    if (result.ok) setMembers(result.members);
    else if (result.signedOut) setSignedOut(true);
    else setLoadError(result.message);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = useCallback(async (key: string, next: RosterChange): Promise<boolean> => {
    setActionError(null);
    setBusy(key);
    const result = await rosterRequest(next);
    if (!mountedRef.current) return false;
    setBusy(null);
    if (result.ok) {
      setMembers(result.members);
      return true;
    }
    if (result.signedOut) setSignedOut(true);
    else setActionError(result.message);
    return false;
  }, []);

  const add = async () => {
    if (await change("add", { action: "add", email: email.trim() })) setEmail("");
  };

  const remove = (member: RosterMember) => {
    if (!window.confirm(ROSTER_COPY.confirmRemove(member.name))) return;
    void change(`remove-${member.id}`, { action: "remove", memberId: member.id });
  };

  const saveSlack = async (memberId: string) => {
    if (savingSlackRef.current || slackCancelledRef.current) return;
    savingSlackRef.current = true;
    const value = slackInput.trim();
    if (await change(`slack-${memberId}`, { action: "slack", memberId, slackUserId: value === "" ? null : value })) setEditingSlack(null);
    savingSlackRef.current = false;
  };

  const slackKeyDown = (event: KeyboardEvent<HTMLInputElement>, memberId: string) => {
    if (event.key === "Enter") void saveSlack(memberId);
    if (event.key === "Escape") {
      slackCancelledRef.current = true;
      setEditingSlack(null);
      setTimeout(() => {
        slackCancelledRef.current = false;
      }, 0);
    }
  };

  if (signedOut) return <TradeRequestsSessionEnded />;

  return (
    <div className={styles.view} data-testid="trade-requests-roster">
      <PageHeader eyebrow={TRADE_REQUESTS_COPY.eyebrow} title={ROSTER_COPY.title} description={ROSTER_COPY.description} />
      <form className={styles.controls} onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <input type="email" className={styles.textInput} value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com" aria-label={ROSTER_COPY.addLabel} />
        <Button type="submit" size="sm" disabled={!EMAIL_PATTERN.test(email.trim()) || busy === "add"}>
          {busy === "add" ? ROSTER_COPY.adding : ROSTER_COPY.addButton}
        </Button>
      </form>
      {actionError && (
        <div role="alert" className={styles.notice}>
          <span>{actionError}</span>
          <button type="button" className={styles.linkButton} onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}
      {loadError ? (
        <div className={styles.notice} role="alert">
          <span>{loadError}</span>
          <button type="button" className={styles.linkButton} onClick={() => void load()}>Retry</button>
        </div>
      ) : loading ? (
        <div className={styles.state} role="status">{ROSTER_COPY.loading}</div>
      ) : members.length === 0 ? (
        <div className={styles.state}>{ROSTER_COPY.empty}</div>
      ) : (
        <Card className={styles.tableCard}>
          <table className={`${styles.table} ${styles.stack}`} data-roster-table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>AOA role</th><th>Eligibility</th><th>Slack</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} data-roster-member={m.id}>
                  <td data-label="Name" className={styles.strong}>{m.name}</td>
                  <td data-label="Email">{m.email}</td>
                  <td data-label="AOA role">{m.aoaRole ?? "—"}</td>
                  <td data-label="Eligibility">
                    <span className={styles.pill} data-tone={m.eligible ? "ok" : "danger"}>{m.eligible ? ROSTER_COPY.eligible : ROSTER_COPY.notEligible}</span>
                  </td>
                  <td data-label="Slack">
                    {editingSlack === m.id ? (
                      <input autoFocus className={styles.slackInput} value={slackInput} onChange={(e) => setSlackInput(e.target.value)}
                        onBlur={() => void saveSlack(m.id)} onKeyDown={(e) => slackKeyDown(e, m.id)} placeholder="U0123456789"
                        aria-label={`Slack member ID for ${m.name}`} />
                    ) : (
                      <button type="button" className={styles.smallLink} title={ROSTER_COPY.editSlack}
                        onClick={() => { setEditingSlack(m.id); setSlackInput(m.slackUserId ?? ""); }}>
                        {m.slackUserId ?? ROSTER_COPY.notLinked}
                      </button>
                    )}
                  </td>
                  <td data-label="">
                    <Button variant="ghost" size="sm" onClick={() => remove(m)} disabled={busy === `remove-${m.id}`}
                      aria-label={`${ROSTER_COPY.remove} ${m.name}`}>{ROSTER_COPY.remove}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
