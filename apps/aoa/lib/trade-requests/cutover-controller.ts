import type { PrismaClient } from "@prisma/client";
import { FREEZE_WINDOW_MS, freezeWindowRefusal, inMorningWindow, morningRelease } from "./cutover-clock";
import { ENGINE_USE_WINDOW_DAYS, engineUseGates, isRefused, standaloneModeGate, type GateResult } from "./cutover-gates";
import { forwardTransitionRefusal, runCopy } from "./records/copy-engine";
import {
  changeServingState,
  copyBackInProgress,
  CUTOVER_FREEZE_REASON,
  lastServingSourceChange,
  lastStandaloneFreeze,
  lastStandaloneFreezeAt,
  readServingStateRecord,
  recordStandaloneTransition,
  ServingStateRefused,
  type ServingStateChange,
} from "./serving-state-admin";
import {
  StandaloneUnavailable,
  type EngineUseReport,
  type StandaloneChange,
  type StandaloneControl,
  type StandaloneState,
} from "./standalone-control";

// The Trade Request cutover and rollback controller (ticket). Every lever is turned in the settled order and
// refused until its gate passes: freeze -> change copy -> verify -> switch; sender handoffs (old sender off before
// the new one on); MCP-only retirement; rollback (standalone-served while frozen -> copy-back -> unfreeze ->
// senders, held until 10:00 inside the weekday morning window); and recovery to the last safe state. Each step is
// ordered so a crash leaves zero writers or zero senders, never two. Nothing here reads or writes AOA's own user
// or account tables.

export type SenderKind = "digest" | "drift";
export type Outcome = "done" | "refused" | "abandoned";
export type CommandResult = { command: string; outcome: Outcome; gates: GateResult[]; steps: string[] };

/** Fresh one-connection clients for one copy run, so the controller's own connection stays free to stop it. */
export type CopyClients = { target: PrismaClient; source: PrismaClient; close: () => Promise<void> };

export type ControllerDeps = {
  /** AOA owner connection with connection_limit=1: the session holds the controller's advisory lock. */
  aoa: PrismaClient;
  /** The standalone database through the copy login (one connection); used to stop a copy at the deadline. */
  source: PrismaClient | null;
  /** Opens the clients each change copy or copy-back runs on; required by cutover and rollback. */
  openCopyClients: (() => Promise<CopyClients>) | null;
  standalone: StandaloneControl;
  actor: string;
  /** The engine-use exemption reference from engineUseExemption(), or null. */
  exemption: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
  /** Pause between change-copy attempts while the freeze window lasts. */
  retryIntervalMs?: number;
  /** Real milliseconds to wait for a change copy given the time left in the freeze window (a test seam). */
  copyDeadlineMs?: (remainingMs: number) => number;
  copy?: typeof runCopy;
};

/** pg advisory lock key held for the whole of every command (one controller run at a time). */
export const CONTROLLER_LOCK_KEY = 390_390_390;
/** How long a cancelled copy may take to unwind before its backends are terminated. */
const CANCEL_GRACE_MS = 5_000;
/** How long to wait for terminated copy backends to disappear before refusing to unfreeze. */
const STOP_CONFIRM_MS = 10_000;

const FIELD = { digest: "digestSender", drift: "driftSender" } as const;
const standaloneSender = (kind: SenderKind, value: "on" | "off"): StandaloneChange =>
  kind === "digest" ? { digestSender: value } : { driftSender: value };
const aoaSender = (kind: SenderKind, value: "standalone" | "aoa"): ServingStateChange =>
  kind === "digest" ? { digestSender: value } : { driftSender: value };
const errorCode = (err: unknown) => String((err as { code?: unknown })?.code ?? (err as Error)?.constructor?.name ?? "error");

/** Resolves true when `promise` settles within `ms` real milliseconds, false otherwise; never leaves a timer behind. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    handle = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), expired]);
  } finally {
    clearTimeout(handle);
  }
}

export class ControllerLockLost extends Error {}
export class CopyStillRunning extends Error {}

type Run = { command: string; gates: GateResult[]; steps: string[] };

export function createCutoverController(deps: ControllerDeps) {
  const { aoa, source, openCopyClients, standalone, actor, exemption } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => undefined);
  const retryIntervalMs = deps.retryIntervalMs ?? 60_000;
  const copyDeadlineMs = deps.copyDeadlineMs ?? ((remaining: number) => remaining);
  const copy = deps.copy ?? runCopy;

  function gate(run: Run, result: GateResult): GateResult {
    run.gates.push(result);
    log({ event: "cutover_gate", command: run.command, ...result });
    if (result.status === "exempt") log({ event: "engine_use_gate_exempted", command: run.command, gate: result.gate, reference: exemption });
    return result;
  }
  const pass = (run: Run, name: string, detail: string) => gate(run, { gate: name, status: "passed", detail });
  const refuse = (run: Run, name: string, detail: string) => gate(run, { gate: name, status: "refused", detail });
  function stop(run: Run, name: string, detail: string): Outcome {
    refuse(run, name, detail);
    return "refused";
  }
  function step(run: Run, text: string): void {
    run.steps.push(text);
    log({ event: "cutover_step", command: run.command, step: text });
  }

  async function holdsLock(): Promise<boolean> {
    const rows = await aoa.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = ${CONTROLLER_LOCK_KEY} AND objsubid = 1
          AND granted AND pid = pg_backend_pid()`,
    );
    return (rows[0]?.n ?? 0) > 0;
  }
  async function assertLock(): Promise<void> {
    if (!(await holdsLock())) throw new ControllerLockLost("the controller lock was lost; nothing further was changed");
  }
  /**
   * Sleeps, then confirms this session still holds the controller lock. The CLI opens the lock connection with
   * max_idle_connection_lifetime=0 (cutover-connection.ts) so Prisma never recycles it; if it is recycled or
   * dropped anyway, the session lock is gone and the command stops here, failing closed.
   */
  async function wait(ms: number): Promise<void> {
    if (ms > 0) await sleep(ms);
    await assertLock();
  }

  async function execute(command: string, body: (run: Run) => Promise<Outcome>): Promise<CommandResult> {
    const run: Run = { command, gates: [], steps: [] };
    let outcome: Outcome = "refused";
    const [lock] = await aoa.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT pg_try_advisory_lock(${CONTROLLER_LOCK_KEY}) AS ok`);
    if (!lock?.ok) {
      refuse(run, "controller_lock", "another controller run is in progress");
    } else {
      try {
        outcome = await body(run);
      } catch (err) {
        if (err instanceof ControllerLockLost) refuse(run, "controller_lock", err.message);
        else if (err instanceof CopyStillRunning) refuse(run, "copy_stopped", err.message);
        else if (err instanceof StandaloneUnavailable || err instanceof ServingStateRefused) refuse(run, "lever", err.message);
        else throw err;
        outcome = "refused";
      } finally {
        await aoa.$queryRawUnsafe(`SELECT pg_advisory_unlock(${CONTROLLER_LOCK_KEY})`);
      }
    }
    log({ event: "cutover_result", command, outcome });
    return { command, outcome, gates: run.gates, steps: run.steps };
  }

  async function readStandalone(run: Run): Promise<StandaloneState | null> {
    try {
      return await standalone.readState();
    } catch (err) {
      if (!(err instanceof StandaloneUnavailable)) throw err;
      refuse(run, "standalone_reachable", err.message);
      return null;
    }
  }

  async function turnStandalone(run: Run, before: StandaloneState, change: StandaloneChange, reason: string): Promise<StandaloneState> {
    const after = await standalone.changeState(change, reason);
    await recordStandaloneTransition(aoa, actor, before, change, after, reason);
    step(run, `standalone ${JSON.stringify(change)}: ${reason}`);
    return after;
  }

  async function turnAoa(run: Run, change: ServingStateChange, reason: string): Promise<void> {
    // The window contains ticket's 07:55-08:10 read-then-claim of digest_sender, so it is checked at the change itself.
    if ((change.digestSender !== undefined || change.driftSender !== undefined) && inMorningWindow(now())) {
      throw new ServingStateRefused("AOA sender fields never change inside 07:30-10:00 America/New_York on a weekday");
    }
    const result = await changeServingState(aoa, change, actor, reason);
    step(run, `${result.changed ? "AOA" : "AOA unchanged"} ${JSON.stringify(change)}: ${reason}`);
  }

  async function engineUse(run: Run): Promise<boolean> {
    let report: EngineUseReport | null = null;
    try {
      report = await standalone.readEngineUse(ENGINE_USE_WINDOW_DAYS);
    } catch (err) {
      if (!(err instanceof StandaloneUnavailable)) throw err;
      step(run, `engine-use report: ${err.code}`);
    }
    return engineUseGates(report, exemption).map((g) => gate(run, g)).every((g) => g.status !== "refused");
  }

  async function backendsGone(targetPid: number, sourcePid: number): Promise<boolean> {
    const count = async (db: PrismaClient, pid: number) =>
      (await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${pid}`))[0].n;
    const giveUpAt = Date.now() + STOP_CONFIRM_MS;
    for (;;) {
      if ((await count(aoa, targetPid)) === 0 && (!source || (await count(source, sourcePid)) === 0)) return true;
      if (Date.now() >= giveUpAt) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Runs one copy on fresh clients, leaving the controller's connection free. With a deadline (forward change
   * copies), the copy is stopped at the end of the freeze window: both of its backends are cancelled, given
   * CANCEL_GRACE_MS to unwind, then terminated (a backend idle inside its transaction ignores a cancel; termination
   * rolls the transaction back). Only when both backends are gone may the caller unfreeze;
   * otherwise the command stops with the service still frozen. The lock is confirmed afterwards.
   */
  async function boundedCopy(run: Run, mode: "change" | "copy_back", deadline: number | null): Promise<void> {
    const label = mode === "change" ? "change copy" : "copy-back";
    const clients = await openCopyClients!();
    try {
      const backend = async (db: PrismaClient) => (await db.$queryRawUnsafe<Array<{ pid: number }>>("SELECT pg_backend_pid() AS pid"))[0].pid;
      const targetPid = await backend(clients.target);
      const sourcePid = await backend(clients.source);
      const attempt = copy({ source: clients.source, target: clients.target, mode, actor }).then(
        (result) => step(run, `${label} ${result.runId}: ${result.verdict}`),
        (err: unknown) => step(run, `${label} did not complete: ${errorCode(err)}`),
      );
      let finished = true;
      if (deadline === null) await attempt;
      else finished = await settlesWithin(attempt, copyDeadlineMs(deadline - now().getTime()));
      if (!finished) {
        step(run, `${label} stopped at the end of the 60-minute freeze window`);
        await aoa.$queryRawUnsafe(`SELECT pg_cancel_backend(${targetPid})::text AS cancelled`);
        if (source) await source.$queryRawUnsafe(`SELECT pg_cancel_backend(${sourcePid})::text AS cancelled`);
        const unwound = await settlesWithin(attempt, CANCEL_GRACE_MS);
        step(run, `${label} ${unwound ? "unwound after cancellation" : `had not unwound ${CANCEL_GRACE_MS / 1000} s after cancellation`}; terminating its backends`);
        await aoa.$queryRawUnsafe(`SELECT pg_terminate_backend(${targetPid})::text AS terminated`);
        if (source) await source.$queryRawUnsafe(`SELECT pg_terminate_backend(${sourcePid})::text AS terminated`);
        if (!(await backendsGone(targetPid, sourcePid))) {
          throw new CopyStillRunning(`the ${label} could not be stopped, so the standalone service stays frozen; run recover once no copy backend remains`);
        }
        step(run, `${label} backends stopped`);
      }
    } finally {
      await clients.close();
    }
    await assertLock();
  }

  async function forwardVerification(sinceDb: Date, deadlineDb: Date): Promise<GateResult> {
    const rows = await aoa.$queryRaw<Array<{ verdict: string | null; finished_at: Date | null }>>`
      SELECT verdict, finished_at FROM trade_request.copy_runs
       WHERE mode IN ('full', 'change') AND started_at >= ${sinceDb}
       ORDER BY started_at DESC LIMIT 1`;
    const latest = rows[0];
    const name = "copy_verification";
    if (!latest) return { gate: name, status: "refused", detail: "no copy verification has run since the freeze's admitted writes settled" };
    if (latest.verdict !== "passed") return { gate: name, status: "refused", detail: `latest copy verification: ${latest.verdict ?? "in progress"}` };
    if (!latest.finished_at || latest.finished_at > deadlineDb) {
      return { gate: name, status: "refused", detail: "latest copy verification passed after the 60-minute freeze window" };
    }
    return { gate: name, status: "passed", detail: "latest copy verification since the freeze passed" };
  }

  async function copyBackVerification(since: Date): Promise<GateResult> {
    const rows = await aoa.$queryRaw<Array<{ verdict: string | null }>>`
      SELECT verdict FROM trade_request.copy_runs
       WHERE mode = 'copy_back' AND started_at >= ${since}
       ORDER BY started_at DESC LIMIT 1`;
    const verdict = rows[0]?.verdict;
    return verdict === "passed"
      ? { gate: "copy_back_verification", status: "passed", detail: "latest copy-back since the rollback started passed" }
      : { gate: "copy_back_verification", status: "refused", detail: `latest copy-back since the rollback started: ${verdict === undefined ? "none" : (verdict ?? "in progress")}` };
  }

  /**
   * Who owns the current freeze, by the recorded reason rather than by timestamp order: a freeze is a forward
   * cutover's only when `cutover` recorded it after the last serving-source change. A rollback is open from the
   * change of the serving source to standalone until a copy-back started after it has passed (WO-AC-13); a later
   * freeze by `rollback` or `recover`, or one made outside the controller, does not close it.
   */
  async function freezeOwner(): Promise<{ forwardFreeze: boolean; openRollback: boolean }> {
    const last = await lastServingSourceChange(aoa);
    const lastFreeze = await lastStandaloneFreeze(aoa);
    const forwardFreeze = lastFreeze !== null && lastFreeze.byCutover && (last === null || lastFreeze.at > last.at);
    const openRollback =
      last !== null && last.to === "standalone" && !forwardFreeze && (await copyBackVerification(last.at)).status !== "passed";
    return { forwardFreeze, openRollback };
  }

  /** Latest verdict of ticket's reconciliation ledger (`at`) or ticket's readiness ledger (`ran_at`). */
  async function latestVerdict(table: "reconciliation_runs" | "drift_readiness_runs"): Promise<string | null> {
    const recordedAt = table === "reconciliation_runs" ? "at" : "ran_at";
    const rows = await aoa.$queryRawUnsafe<Array<{ verdict: string }>>(
      `SELECT verdict FROM trade_request.${table} ORDER BY ${recordedAt} DESC LIMIT 1`,
    );
    return rows[0]?.verdict ?? null;
  }

  /**
   * The MCP-only gate (WO-AC-11): the latest access reconciliation passed, was taken after the final forward copy
   * that could have written (passed, blocked, or with no verdict: in progress or killed), and its counts show
   * standalone identities with none missing (ticket records noStandaloneIdentities; an empty set fails).
   */
  async function reconciliationAfterFinalCopy(): Promise<GateResult> {
    const name = "access_reconciliation";
    const rows = await aoa.$queryRawUnsafe<Array<{ verdict: string; counts: unknown; after_copy: boolean | null }>>(
      `SELECT r.verdict, r.counts,
              r.at > (SELECT max(coalesce(c.finished_at, c.started_at)) FROM trade_request.copy_runs c
                       WHERE c.mode IN ('full', 'change') AND (c.verdict IS NULL OR c.verdict IN ('passed', 'blocked'))) AS after_copy
         FROM trade_request.reconciliation_runs r ORDER BY r.at DESC LIMIT 1`,
    );
    const latest = rows[0];
    if (!latest) return { gate: name, status: "refused", detail: "latest access reconciliation: none" };
    if (latest.verdict !== "passed") return { gate: name, status: "refused", detail: `latest access reconciliation: ${latest.verdict}` };
    if (latest.after_copy === null) return { gate: name, status: "refused", detail: "no forward copy is recorded" };
    if (!latest.after_copy) {
      return { gate: name, status: "refused", detail: "latest access reconciliation was taken before the final forward copy" };
    }
    const counts = (typeof latest.counts === "object" && latest.counts !== null ? latest.counts : {}) as Record<string, unknown>;
    const active = typeof counts.standaloneActive === "number" ? counts.standaloneActive : 0;
    const missing = typeof counts.noStandaloneIdentities === "number" ? counts.noStandaloneIdentities : 1;
    if (active <= 0 || missing !== 0) {
      return { gate: name, status: "refused", detail: `standalone active identities: ${active}; no standalone identities: ${missing}` };
    }
    return { gate: name, status: "passed", detail: `latest access reconciliation passed after the final forward copy (standalone active identities: ${active})` };
  }

  /**
   * The copy engine's own forward-transition refusal, read before the freeze: a change copy it is certain to refuse
   * must not hold the standalone service frozen for 60 minutes of retries.
   */
  async function forwardCopyGate(): Promise<GateResult> {
    const refusal = await forwardTransitionRefusal(aoa, "change");
    return refusal
      ? { gate: "forward_copy_admitted", status: "refused", detail: refusal }
      : { gate: "forward_copy_admitted", status: "passed", detail: "the copy engine admits a change copy" };
  }

  async function abandon(run: Run, state: StandaloneState, reason: string): Promise<Outcome> {
    const serving = await readServingStateRecord(aoa);
    if (serving.servingSource !== "standalone") {
      refuse(run, "serving_source_standalone", "cannot abandon: Trade Requests are not standalone-served");
      return "refused";
    }
    if ((await freezeOwner()).openRollback) {
      return stop(run, "rollback_in_progress", "a rollback's copy-back has not passed, so the standalone service stays frozen: run rollback");
    }
    await turnStandalone(run, state, { mode: "active" }, `cutover abandoned: ${reason}`);
    return "abandoned";
  }

  /** Old sender off, then the standalone sender on (AC-64), for a return to the standalone service. */
  async function returnSender(run: Run, kind: SenderKind): Promise<void> {
    const field = FIELD[kind];
    await turnAoa(run, aoaSender(kind, "standalone"), `${kind} sender to standalone: AOA sender off`);
    const state = await standalone.readState();
    if (state[field] === "off") await turnStandalone(run, state, standaloneSender(kind, "on"), `${kind} sender to standalone: standalone sender on`);
  }

  async function preflight(run: Run): Promise<Outcome> {
    const serving = await readServingStateRecord(aoa);
    const blocking: GateResult[] = [];
    if (!(await engineUse(run))) blocking.push({ gate: "engine_use", status: "refused", detail: "see the engine-use gates" });
    const window = freezeWindowRefusal(now());
    blocking.push(window ? refuse(run, "freeze_window", window) : pass(run, "freeze_window", "no morning job time in the next 60 minutes"));
    const allStandalone = serving.servingSource === "standalone" && serving.digestSender === "standalone" && serving.driftSender === "standalone";
    blocking.push(allStandalone ? pass(run, "serving_state_standalone", "serving source and both senders are standalone") : refuse(run, "serving_state_standalone", `serving state ${JSON.stringify(serving)}`));
    blocking.push(gate(run, standaloneModeGate("standalone_active", await readStandalone(run), "active")));
    blocking.push((await copyBackInProgress(aoa)) ? refuse(run, "copy_back_idle", "a copy-back is in progress") : pass(run, "copy_back_idle", "no copy-back in progress"));
    blocking.push(gate(run, await forwardCopyGate()));
    // Reported for the later levers; they do not decide whether the cutover may start.
    const reconciliation = await latestVerdict("reconciliation_runs");
    gate(run, {
      gate: "later_access_reconciliation",
      status: reconciliation === "passed" ? "passed" : "refused",
      detail: `latest access reconciliation: ${reconciliation ?? "none"} (decides retire, not the cutover)`,
    });
    const readiness = await latestVerdict("drift_readiness_runs");
    gate(run, {
      gate: "later_drift_readiness",
      status: readiness === "ready" ? "passed" : "refused",
      detail: `latest shadow-readiness verdict: ${readiness ?? "none"} (decides the drift handoff, not the cutover)`,
    });
    return isRefused(blocking) ? "refused" : "done";
  }

  async function cutover(run: Run): Promise<Outcome> {
    if (!source || !openCopyClients) return stop(run, "source_database", "TRADE_REQUEST_SOURCE_DATABASE_URL is required");
    const serving = await readServingStateRecord(aoa);
    if (serving.servingSource !== "standalone" || serving.digestSender !== "standalone" || serving.driftSender !== "standalone") {
      refuse(run, "serving_state_standalone", `serving state ${JSON.stringify(serving)}`);
      return "refused";
    }
    pass(run, "serving_state_standalone", "serving source and both senders are standalone");
    let state = await readStandalone(run);
    if (!state) return "refused";
    if (state.override !== null) return stop(run, "standalone_override", `emergency override is set (${state.override})`);
    if (state.mode === "mcp-only") return stop(run, "standalone_mode", "standalone service is MCP-only while standalone-served");

    if (state.mode === "active") {
      const engineOk = await engineUse(run);
      const window = freezeWindowRefusal(now());
      if (window) refuse(run, "freeze_window", window);
      else pass(run, "freeze_window", "no morning job time in the next 60 minutes");
      const copyAdmitted = gate(run, await forwardCopyGate());
      if (!engineOk || window || copyAdmitted.status === "refused") return "refused";
      state = await turnStandalone(run, state, { mode: "frozen" }, CUTOVER_FREEZE_REASON);
      if (gate(run, standaloneModeGate("standalone_frozen", state, "frozen")).status === "refused") return "refused";
    } else {
      // Resume only a freeze this controller recorded for a forward cutover, never a rollback's freeze.
      if (!(await freezeOwner()).forwardFreeze) {
        return stop(run, "freeze_owner", "the current freeze is not a forward cutover's (a rollback or an unrecorded freeze): run rollback or recover");
      }
      step(run, "resuming the forward cutover's freeze");
      if (gate(run, await forwardCopyGate()).status === "refused") return abandon(run, state, "the copy engine would refuse every change copy");
    }

    const freezeDb = await lastStandaloneFreezeAt(aoa);
    if (!freezeDb || !state.modeChangedAt) {
      refuse(run, "freeze_recorded", "the standalone freeze was not recorded by this controller; run recover");
      return "refused";
    }
    const frozenAt = Date.parse(state.modeChangedAt);
    const settledAt = state.writesSettledAt ? Date.parse(state.writesSettledAt) : frozenAt;
    const deadline = frozenAt + FREEZE_WINDOW_MS;
    // Prisma truncates the freeze's microsecond timestamp to milliseconds; +1 ms keeps a copy that started in the
    // same millisecond just before the freeze from counting.
    const sinceDb = new Date(freezeDb.getTime() + 1 + Math.max(0, settledAt - frozenAt));
    const deadlineDb = new Date(freezeDb.getTime() + FREEZE_WINDOW_MS);
    if (now().getTime() < settledAt) {
      step(run, "waiting until writes admitted before the freeze have settled");
      await wait(settledAt - now().getTime());
    }

    let verification = await forwardVerification(sinceDb, deadlineDb);
    while (verification.status !== "passed") {
      if (now().getTime() >= deadline) {
        gate(run, verification);
        return abandon(run, state, "copy verification did not pass within 60 minutes of the freeze");
      }
      await boundedCopy(run, "change", deadline);
      verification = await forwardVerification(sinceDb, deadlineDb);
      if (verification.status !== "passed" && now().getTime() < deadline) {
        await wait(Math.min(retryIntervalMs, deadline - now().getTime()));
      }
    }
    gate(run, verification);

    // Switch gates, read fresh immediately before the switch.
    const engineOk = await engineUse(run);
    const fresh = await readStandalone(run);
    const frozenGate = gate(run, standaloneModeGate("standalone_frozen", fresh, "frozen"));
    const recheck = gate(run, await forwardVerification(sinceDb, deadlineDb));
    const copyBackIdle = (await copyBackInProgress(aoa))
      ? refuse(run, "copy_back_idle", "a copy-back is in progress")
      : pass(run, "copy_back_idle", "no copy-back in progress");
    if (!engineOk || frozenGate.status === "refused" || recheck.status === "refused" || copyBackIdle.status === "refused") {
      if (fresh && fresh.mode === "frozen") return abandon(run, fresh, "a switch gate refused");
      return "refused";
    }
    const reason = exemption ? `cutover: switch to AOA-served (engine-use gate exempted: ${exemption})` : "cutover: switch to AOA-served";
    await turnAoa(run, { servingSource: "aoa" }, reason);
    return "done";
  }

  async function handoff(run: Run, kind: SenderKind, to: "aoa" | "standalone"): Promise<Outcome> {
    const field = FIELD[kind];
    if (inMorningWindow(now())) return stop(run, "morning_window", "sender handoffs wait until after 10:00 America/New_York");
    pass(run, "morning_window", "outside the weekday morning job window");
    const serving = await readServingStateRecord(aoa);
    let state = await readStandalone(run);
    if (!state) return "refused";
    if (state.override !== null) return stop(run, "standalone_override", `emergency override is set (${state.override})`);
    if (to === "aoa") {
      if (serving.servingSource !== "aoa") return stop(run, "serving_source_aoa", "AOA becomes a sender only while AOA-served");
      pass(run, "serving_source_aoa", "Trade Requests are AOA-served");
      if (kind === "drift") {
        const readiness = await latestVerdict("drift_readiness_runs");
        if (readiness !== "ready") return stop(run, "drift_readiness", `latest shadow-readiness verdict: ${readiness ?? "none"}`);
        pass(run, "drift_readiness", "latest shadow-readiness verdict: ready");
      }
      if (state[field] !== "off") state = await turnStandalone(run, state, standaloneSender(kind, "off"), `${kind} sender to AOA: standalone sender off`);
      state = await standalone.readState();
      if (state[field] !== "off") {
        refuse(run, "standalone_sender_off", `the standalone ${kind} sender switch is ${state[field]}`);
        return "refused";
      }
      pass(run, "standalone_sender_off", `the standalone ${kind} sender switch is off`);
      await turnAoa(run, aoaSender(kind, "aoa"), `${kind} sender to AOA`);
      return "done";
    }
    if (serving.servingSource !== "standalone") return stop(run, "serving_source_standalone", "the standalone service becomes a sender only while standalone-served");
    pass(run, "serving_source_standalone", "Trade Requests are standalone-served");
    await returnSender(run, kind);
    return "done";
  }

  async function retire(run: Run): Promise<Outcome> {
    const gates = [gate(run, await reconciliationAfterFinalCopy())];
    const serving = await readServingStateRecord(aoa);
    gates.push(
      serving.servingSource === "aoa" && serving.digestSender === "aoa" && serving.driftSender === "aoa"
        ? pass(run, "aoa_served_and_sending", "AOA serves and sends both jobs")
        : refuse(run, "aoa_served_and_sending", `serving state ${JSON.stringify(serving)}`),
    );
    const state = await readStandalone(run);
    gates.push(gate(run, standaloneModeGate("standalone_frozen", state, "frozen")));
    if (state) {
      gates.push(
        state.digestSender === "off" && state.driftSender === "off"
          ? pass(run, "standalone_senders_off", "both standalone sender switches are off")
          : refuse(run, "standalone_senders_off", `standalone switches digest=${state.digestSender} drift=${state.driftSender}`),
      );
    }
    if (!state || isRefused(gates)) return "refused";
    await turnStandalone(run, state, { mode: "mcp-only" }, "retire: standalone access off except MCP");
    return "done";
  }

  async function rollback(run: Run): Promise<Outcome> {
    if (!source || !openCopyClients) return stop(run, "source_database", "TRADE_REQUEST_SOURCE_DATABASE_URL is required");
    const serving = await readServingStateRecord(aoa);
    let state = await readStandalone(run);
    if (!state) return "refused";
    if (state.override !== null) return stop(run, "standalone_override", `emergency override is set (${state.override})`);

    if (serving.servingSource === "aoa") {
      if (state.mode !== "frozen") state = await turnStandalone(run, state, { mode: "frozen" }, "rollback: freeze");
      if (gate(run, standaloneModeGate("standalone_frozen", state, "frozen")).status === "refused") return "refused";
      await turnAoa(run, { servingSource: "standalone" }, "rollback: standalone-served while the standalone service is frozen");
    } else {
      const last = await lastServingSourceChange(aoa);
      if (!last) return stop(run, "rollback_started", "Trade Requests have never been AOA-served, so there is nothing to roll back");
      if ((await freezeOwner()).forwardFreeze && state.mode !== "active") {
        return stop(run, "rollback_started", "the current freeze belongs to a forward cutover: run recover");
      }
      step(run, "resuming the rollback");
    }
    const startedAt = (await lastServingSourceChange(aoa))!.at;

    if (state.mode === "mcp-only") state = await turnStandalone(run, state, { mode: "frozen" }, "rollback: freeze");
    if (state.mode === "frozen") {
      let verified = await copyBackVerification(startedAt);
      if (verified.status !== "passed") {
        // Writes the standalone service admitted just before this freeze commit within writesSettledAt (ticket Note 2).
        const settledAt = state.writesSettledAt ? Date.parse(state.writesSettledAt) : 0;
        if (now().getTime() < settledAt) {
          step(run, "waiting until writes admitted before the freeze have settled");
          await wait(settledAt - now().getTime());
        }
        await boundedCopy(run, "copy_back", null);
        verified = await copyBackVerification(startedAt);
      }
      if (gate(run, verified).status === "refused") return "refused";
      const afterCopyBack = await readServingStateRecord(aoa);
      if (afterCopyBack.servingSource !== "standalone") return stop(run, "serving_source_standalone", "Trade Requests are not standalone-served");
      state = await turnStandalone(run, state, { mode: "active" }, "rollback: copy-back verified; standalone writes resume");
    } else {
      // Unfrozen outside this controller: the senders still return only after a passed copy-back.
      const verified = await copyBackVerification(startedAt);
      if (verified.status !== "passed") {
        return stop(
          run,
          "copy_back_verification",
          "the standalone service is active but no copy-back since the rollback started has passed; do not run another copy-back, it would overwrite standalone writes",
        );
      }
      gate(run, verified);
      step(run, "standalone service already accepts writes");
    }

    for (const kind of ["digest", "drift"] as const) {
      const field = FIELD[kind];
      const current = await readServingStateRecord(aoa);
      const standaloneState = await standalone.readState();
      if (current[field] === "standalone" && standaloneState[field] === "on") continue;
      const release = morningRelease(now());
      if (release) {
        step(run, `morning hold: the ${kind} sender returns at 10:00 America/New_York`);
        await wait(release.getTime() - now().getTime());
      }
      await returnSender(run, kind);
    }
    return "done";
  }

  async function recover(run: Run): Promise<Outcome> {
    let serving = await readServingStateRecord(aoa);
    let state = await readStandalone(run);
    if (!state) return "refused";
    if (state.override !== null) return stop(run, "standalone_override", `emergency override is set (${state.override})`);

    if (serving.servingSource === "aoa" && state.mode === "active") {
      state = await turnStandalone(run, state, { mode: "frozen" }, "recover: two writers; freeze the standalone service");
    } else if (serving.servingSource === "standalone" && state.mode !== "active") {
      if ((await freezeOwner()).openRollback) {
        refuse(run, "rollback_in_progress", "a rollback's copy-back has not passed; run rollback");
        return "refused";
      }
      state = await turnStandalone(run, state, { mode: "active" }, "recover: standalone-served; standalone writes resume");
    }

    for (const kind of ["digest", "drift"] as const) {
      const field = FIELD[kind];
      serving = await readServingStateRecord(aoa);
      state = await standalone.readState();
      const standaloneOn = state[field] === "on";
      const aoaOn = serving[field] === "aoa";
      if (standaloneOn && aoaOn) {
        // Inside the morning window AOA's sender fields stay untouched (ticket reads digest_sender, then claims).
        if (serving.servingSource === "aoa" || inMorningWindow(now())) {
          await turnStandalone(run, state, standaloneSender(kind, "off"), `recover: two ${kind} senders; standalone sender off`);
        } else {
          await turnAoa(run, aoaSender(kind, "standalone"), `recover: two ${kind} senders; AOA sender off`);
        }
      } else if (!standaloneOn && !aoaOn) {
        if (serving.servingSource === "aoa") step(run, `no ${kind} sender while AOA-served: run handoff-${kind}-to-aoa`);
        else if (inMorningWindow(now())) refuse(run, "morning_window", `no ${kind} sender; re-run recover after 10:00 America/New_York`);
        else await turnStandalone(run, state, standaloneSender(kind, "on"), `recover: no ${kind} sender; standalone sender on`);
      }
    }
    return isRefused(run.gates) ? "refused" : "done";
  }

  return {
    preflight: () => execute("preflight", preflight),
    cutover: () => execute("cutover", cutover),
    handoff: (kind: SenderKind, to: "aoa" | "standalone") => execute(`handoff-${kind}-to-${to}`, (run) => handoff(run, kind, to)),
    retire: () => execute("retire", retire),
    rollback: () => execute("rollback", rollback),
    recover: () => execute("recover", recover),
  };
}
