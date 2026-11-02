// Demo seed part: the asset-transfer workspace. Every movement in transfers-plan.ts becomes one app.transfer with
// the records the workspace's own actions leave behind, in the order they happened: the intake (createTransfer with
// its receiving account and the stage's default checklist), the client request, statement and account-type match,
// the approved funding plan, paperwork, mailings, the submission and ACAT link, tracking updates, rejections, the
// receipt review, stage changes with the checklist each stage seeds, the Slack closeout, fee reimbursement,
// residuals and outcomes. Each record carries the day it happened and the audit row its action writes (the workspace
// activity and the transfer's history read those).
//
// The writes run as the app login with the acting person's role, as withUserScope runs them, so the transfer tables'
// row security admits them exactly as it admits the app. They are made in that order but sent together (batch.ts:
// runInOrder), so the part costs a few round trips instead of one per row. Every row's id is derived from its
// transfer's, so a reset rebuilds the same ids. The asset-map link columns, trade-request links and the tracker's
// records belong to their own parts.

import {
  TRANSFER_ACCOUNT_MATCH_RECORD, TRANSFER_ACCOUNT_STATUS, TRANSFER_ACH_INITIATION_RECORD, TRANSFER_CHECK_TICKET_RECORD,
  TRANSFER_CREATE, TRANSFER_FOLLOW_UP_RECORD, TRANSFER_FUNDING_PLAN_APPROVE, TRANSFER_MAILING_RECORD,
  TRANSFER_OUTCOME_RECORD, TRANSFER_RECEIPT_RECORD, TRANSFER_SLACK_CLOSEOUT, TRANSFER_STAGE_CHANGE,
  TRANSFER_STATEMENT_RECORD, TRANSFER_SUBMISSION_RECORD, TRANSFER_TASK_TOGGLE, TRANSFER_TRACKING_RECORD, TRANSFER_UPDATE,
} from "@/lib/audit";
import { DRS_TASKS, drsTaskSourceKey } from "@/lib/data/drs-workflow";
import { PARTIAL_ACAT_EXECUTION_TASKS } from "@/lib/data/partial-acat-tasks";
import { SLACK_CLOSEOUT_TEMPLATE } from "@/lib/data/slack-closeout-template";
import { DEFAULT_TASKS, type TransferInput, type TransferStage } from "@/lib/data/transfer-types";
import { validateTransferInput } from "@/lib/data/transfer-validate";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import { journeyStops } from "@/lib/transfers/mailing";
import { mailingContentsText } from "@/lib/transfers/mailing-journeys";
import { formTitleVersion } from "@/lib/transfers/route-label";
import { actAsWrite, insertWrite, runInOrder, type Row, type Write } from "./batch";
import { addBusinessDays } from "./calendar";
import type { SeedContext } from "./context";
import { ACCOUNT_TYPE_LABEL } from "./people";
import { planFundingWork, REGISTRATION, type Actor, type Movement } from "./transfers-plan";
import { accountUlid, demoCuid, seededInt } from "./universe";

// The owning team of each default checklist title (the work queue filters on it).
const TASK_TEAM: Record<string, "Client Service" | "Operations" | "Operations / Client Service"> = {
  "Collect statements": "Client Service",
  "Run asset mapper": "Operations",
  "Send decision worksheet": "Client Service",
  "Asset decisions finalized": "Operations / Client Service",
  "Open receiving accounts": "Client Service",
  "Confirm account numbers": "Operations",
  "ACAT submitted to Apex": "Operations",
  "Transfer accepted by contra": "Operations",
  "Positions settling": "Operations",
  "Cost basis received": "Operations",
  "All positions received": "Operations",
  "Cost basis verified": "Operations",
  "Transition template applied": "Operations",
  "Fee reimbursement filed": "Operations / Client Service",
};

// Where each step falls in a working day, so the steps of one day read in the order they happen (the intake before the
// statement, the plan before the paperwork, the submission before the stage move). A checklist tick follows its step.
const STEP_ORDER: Array<[RegExp, number]> = [
  [/^created$/, 0], [/^request$/, 1], [/^opened$/, 2], [/^statement$/, 3], [/^decisions$/, 3.5], [/^match$/, 4],
  [/^plan$/, 6], [/^partial-(\d)$/, 6.5], [/^drs-(\d)$/, 6.5], [/^form$/, 8], [/^app$/, 9], [/^packet$/, 10],
  [/^mailing$/, 11], [/^signature$/, 12], [/^mailed$/, 13], [/^drs-request$/, 14], [/^check$/, 15], [/^ach$/, 16],
  [/^added-/, 7.5], [/^submission$/, 17], [/^link$/, 17.5], [/^in-transfer$/, 18], [/^tracking-(\d+)$/, 20],
  [/^rejection$/, 21], [/^response$/, 22], [/^cash$/, 23], [/^receipt$/, 24], [/^funded$/, 25], [/^fee$/, 26],
  [/^residual$/, 27], [/^outcome$/, 28], [/^closeout/, 29], [/^archived$/, 30], [/^updated$/, 31],
];
const TASK_STEP: Record<string, number> = {
  "Collect statements": 3.3, "Send decision worksheet": 4.5, "Open receiving accounts": 2.3, "Confirm account numbers": 4.3,
  "Run asset mapper": 5.5, "Asset decisions finalized": 6.3, "ACAT submitted to Apex": 18.3,
  "Transfer accepted by contra": 20.5, "Positions settling": 24.3, "Cost basis received": 24.6, "All positions received": 25.3,
  "Cost basis verified": 25.6, "Transition template applied": 25.8, "Fee reimbursement filed": 26.3,
};

function stepOf(key: string): number {
  if (key.startsWith("task-")) return TASK_STEP[key.slice(5)] ?? 7.6;
  for (const [pattern, rank] of STEP_ORDER) {
    const match = pattern.exec(key);
    if (match) return rank + (match[1] ? Math.min(Number(match[1]), 9) * 0.05 : 0);
  }
  return 15;
}

type AuditEvent = { day: string; key: string; actor: Actor; action: string; detail: Record<string, unknown> };

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);
const later = (a: string, b: string) => (a > b ? a : b);

/** The person the next writes are made as (the GUCs withUserScope sets; the row policies read them). */
const actAs = (actor: Actor): Write => actAsWrite(actor.role, actor.email);

export async function seedTransfers(ctx: SeedContext): Promise<Record<string, number>> {
  const work = planFundingWork(ctx);
  const dealIds = ctx.shared.deals?.ids ?? new Map<string, string>();
  const counts: Record<string, number> = { transfers: 0, tasks: 0, audit: 0 };
  const writes: Write[] = [];
  for (const m of work.movements) {
    const dealId = dealIds.get(m.dealSfId);
    if (!dealId) throw new Error(`Seed transfer ${m.transferId}: deal ${m.dealSfId} was not seeded`);
    // Each movement starts as the person who opened it, as its own withUserScope transaction did.
    writes.push(actAs(m.createdBy));
    const written = writeMovement(ctx, m, dealId);
    writes.push(...written.writes);
    counts.transfers++;
    counts.tasks += written.tasks;
    counts.audit += written.audit;
    const lane = m.archived ? "archived" : m.stage.toLowerCase();
    counts[lane] = (counts[lane] ?? 0) + 1;
  }
  // As the app login, as withUserScope runs the workspace's writes.
  await ctx.owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE app_rw");
    await runInOrder(tx, writes);
  }, { maxWait: 10_000, timeout: 120_000 });
  return counts;
}

function writeMovement(ctx: SeedContext, m: Movement, dealId: string): { writes: Write[]; tasks: number; audit: number } {
  const writes: Write[] = [];
  // One row, or a run of rows of one table, in the order the workspace's actions write them. Returns the first id.
  const insert = (table: string, ...rows: Row[]) => {
    if (rows.length) writes.push(insertWrite(`app.${table}`, rows));
    return rows[0]?.id as string;
  };
  // A record's id, derived from its transfer's so every seed writes the same one.
  const idOf = (kind: string, n = 1) => demoCuid(`${m.transferId}:${kind}:${n}`);
  // 9 AM New York (13:00 UTC in daylight time; close enough for history) plus a quarter hour per step, never after now.
  const at = (d: string, key: string) => {
    const step = stepOf(key);
    const instant = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 13, 0)
      + (step * 15 + seededInt(`${m.key}:${key}`, 0, 8)) * 60_000;
    return new Date(Math.min(instant, ctx.now.getTime() - (32 - step) * 60_000));
  };
  const events: AuditEvent[] = [];
  const event = (d: string, key: string, actor: Actor, action: string, detail: Record<string, unknown>) =>
    events.push({ day: d, key, actor, action, detail });
  const client = m.owners[0];
  const clientName = m.owners.map((p) => `${p.first} ${p.last}`).join(" & ");
  const jordan = m.plan?.by ?? m.inTransfer?.by ?? m.createdBy;
  const helen = m.createdBy;
  const custodianId = ctx.shared.tracker?.custodianIds.get(m.firm) ?? null;
  const receivingType = m.newReceiving?.type ?? ACCOUNT_TYPE_LABEL[m.account.type] ?? "Individual";
  const receivingLast4 = m.account.number.replace(/\W/g, "").slice(-4);

  // --- the transfer row, in its current state (one insert, so the row-change trail is the creation) ---

  const input: TransferInput = {
    source: "APP",
    client_first_name: client.first,
    client_last_name: client.last,
    client_sf_id: ctx.personId.get(client.id)!,
    household_name: m.household.name,
    household_sf_id: ctx.householdId.get(m.household.id)!,
    value: m.value,
    stage: m.stage,
    owner_kind: m.owner.kind,
    owner_name: m.owner.name,
    next_step: m.nextStep,
    next_step_owner: m.nextStepOwner,
    acat_transfer_id: m.acatTransferId,
    funding_type: m.fundingType,
  };
  const check = validateTransferInput(input);
  if (!check.ok) {
    throw new Error(`Seed transfer ${m.transferId} fails validateTransferInput: ${check.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
  }
  const stageAt = m.funded ? at(m.funded.day, "funded") : m.inTransfer ? at(m.inTransfer.day, "in-transfer") : at(m.created, "created");
  const linked = m.trackerId != null && m.submission != null || (m.trackerId != null && m.inTransfer != null);
  const lastDay = [m.created, m.statement?.day, m.plan?.day, m.submission?.day, m.inTransfer?.day, m.funded?.day,
    m.tracking.at(-1)?.day, m.rejection?.response?.day ?? m.rejection?.day, m.outcome?.day, m.archived?.day,
    m.receipt?.day, m.mailing?.day].filter((d): d is string => !!d).reduce(later);
  insert("transfer", {
    id: m.transferId,
    source: input.source,
    client_first_name: input.client_first_name,
    client_last_name: input.client_last_name,
    client_sf_id: input.client_sf_id,
    household_name: input.household_name,
    household_sf_id: input.household_sf_id,
    value: input.value,
    stage: input.stage,
    stage_entered_at: stageAt,
    owner_kind: input.owner_kind,
    owner_name: input.owner_name,
    next_step: input.next_step,
    next_step_owner: input.next_step_owner,
    acat_transfer_id: linked ? m.acatTransferId : null,
    acat_record_id: linked ? m.trackerId : null,
    acat_link_provenance: linked ? "MANUAL" : null,
    acat_auto_link_hold: linked,
    funding_type: m.fundingType,
    accounts_opened_at_apex: (m.newReceiving ? m.newReceiving.open : m.receivingOpen) != null,
    funding_plan_complete: m.plan != null,
    funding_plan_version: m.plan ? 1 : 0,
    funding_plan_approved_at: m.plan ? at(m.plan.day, "plan") : null,
    funding_plan_approved_by: m.plan ? m.plan.by.email : null,
    funding_initiated: m.stage !== "DECISION",
    cash_in_flight: m.cashInFlight != null && m.stage === "IN_TRANSFER",
    deal_id: dealId,
    deal_sf_id: m.dealSfId,
    transferring_firm: m.firm,
    delivering_custodian_id: custodianId,
    archived_at: m.archived ? at(m.archived.day, "archived") : null,
    archived_by: null,
    archived_reason: m.archived?.reason ?? null,
    sync_flag: m.syncFlag ?? null,
    client_requested_on: m.clientRequest ? day(m.clientRequest.day) : null,
    client_request_source: m.clientRequest?.source ?? null,
    source_account_type: m.sourceType,
    source_account_last4: m.sourceLast4,
    source_account_title: clientName,
    receiving_account_type: receivingType,
    receiving_account_title: clientName,
    created_by: helen.email,
    updated_by: (m.funded?.by ?? m.inTransfer?.by ?? m.plan?.by ?? helen).email,
    created_at: at(m.created, "created"),
    updated_at: at(lastDay, "updated"),
  });
  event(m.created, "created", helen, TRANSFER_CREATE, {
    stage: "DECISION", value: m.value, source: "APP", fundingType: m.fundingType,
    receivingAccountOpen: !m.newReceiving && m.receivingOpen != null,
  });

  // --- intake: the receiving account, the client request, the statement and the account-type match ---

  const opened = m.newReceiving ? m.newReceiving.open : m.receivingOpen;
  const accountId = insert("transfer_account", {
    id: `${m.transferId}-acct-1`,
    transfer_id: m.transferId,
    label: m.newReceiving || m.receivingOpen == null ? `${receivingType} · ${clientName}` : `${receivingType} · Apex ••••${receivingLast4}`,
    status: opened ? "OPEN" : "TO_OPEN",
    opened_at: opened ? at(opened, "opened") : null,
    created_at: at(m.created, "created"),
    updated_at: at(opened ?? m.created, "opened"),
  });
  if (opened && opened > m.created) {
    event(opened, "opened", helen, TRANSFER_ACCOUNT_STATUS, { accountId, from: "TO_OPEN", to: "OPEN" });
  }
  if (m.clientRequest) {
    event(m.clientRequest.day, "request", helen, TRANSFER_UPDATE, { kind: "client_request", source: m.clientRequest.source });
  }
  if (m.statement) {
    const statementId = insert("transfer_statement", {
      id: idOf("statement"), transfer_id: m.transferId, accepted: m.statement.accepted,
      created_at: at(m.statement.day, "statement"), updated_at: at(m.statement.day, "statement"),
    });
    event(m.statement.day, "statement", helen, TRANSFER_STATEMENT_RECORD, { statementId, accepted: m.statement.accepted, approvalCleared: false });
  }
  if (m.match) {
    const registration = REGISTRATION[m.account.type] ?? "Individual";
    const accountMatchId = insert("transfer_account_match", {
      id: idOf("match"), transfer_id: m.transferId, delivering_account_type: registration,
      receiving_account_type: m.newReceiving ? "Traditional IRA" : registration,
      created_at: at(m.match, "match"), updated_at: at(m.match, "match"),
    });
    event(m.match, "match", helen, TRANSFER_ACCOUNT_MATCH_RECORD, { accountMatchId, match: true, approvalCleared: false });
  }

  // --- the funding plan, its position decisions and the partial-ACAT or DRS steps it starts ---

  writes.push(actAs(m.plan?.by ?? helen));
  const decisions = m.plan?.decisions ?? m.worksheet ?? [];
  const decisionIds = decisions.map((_, i) => `${m.transferId}-dec-${i + 1}`);
  insert("transfer_decision", ...decisions.map((d, i) => {
    const decided = d.decision !== "UNDECIDED" && m.plan != null;
    return {
      id: decisionIds[i],
      transfer_id: m.transferId,
      symbol: d.symbol,
      description: d.description,
      value: d.value,
      cost_basis: d.basis,
      decision: d.decision,
      decided_by: decided ? m.plan!.by.email : null,
      decided_at: decided ? at(m.plan!.day, "plan") : null,
      cannot_transfer_in_kind: d.liquidate === true,
      ineligible: d.liquidate === true,
      liquidation_instruction: d.liquidate === true,
      created_at: at(m.statement?.day ?? m.created, "decisions"),
      updated_at: at(m.plan?.day ?? m.statement?.day ?? m.created, "decisions"),
    };
  }));
  if (m.plan) {
    const plan = m.plan;
    const positions = m.fundingType === "ACAT_PARTIAL" ? (m.plan.decisions ?? []) : [];
    if (m.fundingType === "ACAT_PARTIAL") {
      insert("transfer_position_flag", ...positions.map((d, i) => ({
        id: idOf("position-flag", i + 1), transfer_id: m.transferId, symbol: d.symbol, is_transferring: d.decision === "BRING_IN",
        decided_by: plan.by.email, decided_at: at(plan.day, "plan"),
        created_at: at(plan.day, "plan"), updated_at: at(plan.day, "plan"),
      })));
    }
    const snapshot = m.fundingType === "ACAT_PARTIAL" && positions.length
      ? {
          source: "transfer-decisions",
          positions: positions.map((d, i) => ({
            decisionId: decisionIds[i], symbol: d.symbol, description: d.description, value: d.value, costBasis: d.basis,
            decision: d.decision,
          })),
        }
      : { source: "none", positions: [] };
    insert("transfer_funding_plan_approval", {
      id: idOf("funding-plan"), transfer_id: m.transferId, version: 1, funding_type: m.fundingType, snapshot,
      note: null, approved_by: m.plan.by.email, approved_at: at(m.plan.day, "plan"),
    });
    const executionTasks = m.fundingType === "ACAT_PARTIAL" ? PARTIAL_ACAT_EXECUTION_TASKS.length : 0;
    event(m.plan.day, "plan", m.plan.by, TRANSFER_FUNDING_PLAN_APPROVE, {
      version: 1, fundingType: m.fundingType, source: snapshot.source, positionCount: positions.length,
      transferringCount: positions.filter((d) => d.decision === "BRING_IN").length, executionTaskCount: executionTasks,
      ...(m.fundingType === "DRS" ? { drsTaskCount: DRS_TASKS.length } : {}),
      hasNote: false,
    });
    if (m.fundingType === "ACAT_PARTIAL") {
      insert("decision_task", ...PARTIAL_ACAT_EXECUTION_TASKS.map((task, i) => {
        const done = i < (m.partialTasksDone ?? 0);
        const doer = task.owner === "CLIENT_SERVICE" ? helen : jordan;
        const doneDay = i === 0 ? (m.returnedSignature ?? plan.day) : (m.submission?.day ?? m.inTransfer?.day ?? plan.day);
        return {
          id: idOf("partial-task", i + 1), source_key: `asset-transfer:${m.transferId}:standard-partial-acat:${task.key}`,
          decision_id: null, transfer_id: m.transferId, task_key: task.key, title: task.title, owner_team: task.owner,
          status: done ? "DONE" : i === (m.partialTasksDone ?? 0) ? "IN_PROGRESS" : "TODO", priority: "HIGH",
          sort_order: task.sort, completed_by: done ? doer.email : null, completed_at: done ? at(doneDay, `partial-${i}`) : null,
          created_by: plan.by.email, created_at: at(plan.day, "plan"), updated_at: at(done ? doneDay : plan.day, `partial-${i}`),
        };
      }));
    }
    if (m.fundingType === "DRS") {
      insert("decision_task", ...DRS_TASKS.map((task, i) => {
        const done = i < (m.drsTasksDone ?? 0);
        const doer = task.ownerTeam === "CLIENT_SERVICE" ? helen : jordan;
        const doneDay = i < 4 ? plan.day : (m.inTransfer?.day ?? plan.day);
        return {
          id: idOf("drs-task", i + 1), source_key: drsTaskSourceKey(m.transferId, task.key), decision_id: null, transfer_id: m.transferId,
          task_key: task.taskKey, title: task.title, owner_team: task.ownerTeam,
          status: done ? "DONE" : i === (m.drsTasksDone ?? 0) ? "IN_PROGRESS" : "TODO", priority: "HIGH", sort_order: i,
          completed_by: done ? doer.email : null, completed_at: done ? at(doneDay, `drs-${i}`) : null,
          created_by: plan.by.email, created_at: at(plan.day, "plan"), updated_at: at(done ? doneDay : plan.day, `drs-${i}`),
        };
      }));
    }
  }

  // --- paperwork, mailings and the channel records ---

  writes.push(actAs(helen));
  const stamps = (d: string, key: string) => ({ created_at: at(d, key), updated_at: at(d, key) });
  const paperwork = (table: string, key: string, d: string | undefined, row: Row = {}, detail: Record<string, boolean> = {}) => {
    if (!d) return;
    const recordId = insert(table, { id: idOf(table), transfer_id: m.transferId, ...row, ...stamps(d, key) });
    event(d, key, helen, TRANSFER_UPDATE, { paperworkRecord: table, recordId, ...detail });
  };
  paperwork("transfer_form_review", "form", m.formReview, {
    reviewed: true, receiving_form_title: clientName, source_form_title: clientName,
    title_owners_confirmed: formTitleVersion(clientName, clientName), apex_account_id: accountUlid(m.account.id),
    form_id: ACAT_DEFINITION.id,
  }, { reviewed: true });
  paperwork("transfer_app_authorization", "app", m.appAuthorization);
  paperwork("transfer_sent_packet", "packet", m.sentPacket);
  paperwork("transfer_returned_signature", "signature", m.returnedSignature);
  paperwork("transfer_mailed_paperwork", "mailed", m.mailedPaperwork);
  paperwork("transfer_drs_service_request", "drs-request", m.drsServiceRequest);
  if (m.mailing) {
    const mailing = m.mailing;
    const stops = journeyStops(mailing.journey);
    const mailingId = insert("transfer_mailing", {
      id: idOf("mailing"), transfer_id: m.transferId, reason: mailing.reason, contents: mailingContentsText(mailing.items, mailing.note ?? null),
      content_items: mailing.items, contents_note: mailing.note ?? null, journey: mailing.journey,
      postage: mailing.postage ?? null, ...stamps(mailing.day, "mailing"),
    });
    insert("transfer_mailing_leg", ...stops.slice(1).map((to, i) => {
      const leg = mailing.legs[i] ?? {};
      return {
        id: idOf("mailing-leg", i + 1), mailing_id: mailingId, leg_number: i + 1, from_stop: stops[i], to_stop: to,
        carrier: leg.carrier ?? null, tracking_number: leg.tracking ?? null,
        mailed_on: leg.mailed ? day(leg.mailed) : null, received_on: leg.received ? day(leg.received) : null,
        ...stamps(mailing.day, "mailing"),
      };
    }));
    event(m.mailing.day, "mailing", helen, TRANSFER_MAILING_RECORD, {
      mailingId, reason: m.mailing.reason, contentItems: m.mailing.items, journey: m.mailing.journey,
      hasPostage: m.mailing.postage != null, trackedLegs: m.mailing.legs.filter((leg) => leg.tracking).length,
    });
  }
  if (m.checkTicket) {
    const checkTicketId = insert("transfer_check_ticket", {
      id: idOf("check-ticket"), transfer_id: m.transferId, location: "client", mailer_sent: m.checkTicket.mailerSent,
      check_mailed: m.checkTicket.checkMailed, optional_call: false, ...stamps(m.checkTicket.day, "check"),
    });
    event(m.checkTicket.day, "check", helen, TRANSFER_CHECK_TICKET_RECORD, { checkTicketId, withClient: true });
  }
  if (m.achInitiation) {
    const achInitiationId = insert("transfer_ach_initiation", {
      id: idOf("ach-initiation"), transfer_id: m.transferId, instructions_sent: true, client_initiation_on: day(m.achInitiation.clientDay),
      ...stamps(m.achInitiation.day, "ach"),
    });
    event(m.achInitiation.day, "ach", helen, TRANSFER_ACH_INITIATION_RECORD, { achInitiationId, stageMoved: true });
  }

  // --- submission, the ACAT link, stage changes and tracking ---

  writes.push(actAs(jordan));
  if (m.submission) {
    const submissionId = insert("transfer_submission", {
      id: idOf("submission"), transfer_id: m.transferId, control_number: m.submission.control, submitted_on: day(m.submission.day),
      ...stamps(m.submission.day, "submission"),
    });
    event(m.submission.day, "submission", jordan, TRANSFER_SUBMISSION_RECORD, { submissionId });
  }
  if (linked) {
    const linkDay = m.submission?.day ?? m.inTransfer!.day;
    event(linkDay, "link", jordan, TRANSFER_UPDATE, {
      changes: {
        acat_record_id: { from: null, to: m.trackerId },
        ...(m.acatTransferId ? { acat_transfer_id: { from: null, to: m.acatTransferId } } : {}),
      },
      acat_link_version: 1, provenance: "MANUAL", automation_hold: true, decision_id: null,
      link_before: { recordId: null, transferUuid: null }, link_after: { recordId: m.trackerId, transferUuid: m.acatTransferId },
    });
  }
  const stageMove = (from: TransferStage, to: TransferStage, d: string, by: Actor, key: string) => {
    writes.push(actAs(by));
    insert("transfer_stage_change", { id: idOf("stage-change", to === "FUNDED" ? 2 : 1), transfer_id: m.transferId, previous_stage: from, new_stage: to, ...stamps(d, key) });
    if (!(m.achInitiation && to === "IN_TRANSFER")) event(d, key, by, TRANSFER_STAGE_CHANGE, { from, to });
  };
  if (m.inTransfer) stageMove("DECISION", "IN_TRANSFER", m.inTransfer.day, m.inTransfer.by, "in-transfer");
  if (m.funded) stageMove("IN_TRANSFER", "FUNDED", m.funded.day, m.funded.by, "funded");
  writes.push(actAs(jordan));
  const trackingIds = m.tracking.map((_, i) => idOf("tracking-update", i + 1));
  insert("transfer_tracking_update", ...m.tracking.map((update, i) => ({
    id: trackingIds[i], transfer_id: m.transferId, tracking_stage: update.stage,
    expected_completion_on: update.expected ? day(update.expected) : null, ...stamps(update.day, `tracking-${i}`),
  })));
  for (const [i, update] of m.tracking.entries()) {
    // A rejection writes its own tracking row; the rejection's audit row covers it.
    if (update.stage !== "ACAT rejected") {
      event(update.day, `tracking-${i}`, jordan, TRANSFER_TRACKING_RECORD, { trackingUpdateId: trackingIds[i], hasExpectedCompletion: update.expected != null });
    }
  }
  if (m.cashInFlight) {
    event(m.cashInFlight, "cash", jordan, TRANSFER_UPDATE, { changes: { cash_in_flight: { from: false, to: true } } });
  }

  // --- follow-up: rejection, receipt review, fee reimbursement, residual, outcome ---

  if (m.rejection) {
    const r = m.rejection;
    const recordId = insert("transfer_acat_rejection", {
      id: idOf("acat-rejection"), transfer_id: m.transferId, completion_estimate: null, arrival_paused: true, follow_up_owner: r.owner,
      response: r.response?.text ?? null, reason: r.reason, code: r.code, rejected_on: day(r.day),
      awaiting_operations_review: r.response != null, created_at: at(r.day, "rejection"), updated_at: at(r.response?.day ?? r.day, "rejection"),
    });
    event(r.day, "rejection", jordan, TRANSFER_FOLLOW_UP_RECORD, { recordId, kind: "acat_rejection" });
    if (r.response) event(r.response.day, "response", helen, TRANSFER_FOLLOW_UP_RECORD, { recordId, kind: "rejection_response" });
  }
  if (m.receipt) {
    const r = m.receipt;
    const receiptId = insert("transfer_receipt", {
      id: idOf("receipt"), transfer_id: m.transferId, version: 1, partial: r.partial != null, next_action: r.partial?.nextAction ?? null,
      follow_up_owner: r.partial?.owner ?? null, next_check_on: r.partial ? day(r.partial.nextCheck) : null,
      ...stamps(r.day, "receipt"),
    });
    insert("transfer_receipt_line", ...Array.from({ length: r.lines }, (_, i) => {
      const mismatch = r.mismatch && i === r.lines - 1;
      const outstanding = r.partial && i >= Math.ceil(r.lines / 2);
      return {
        id: idOf("receipt-line", i + 1), receipt_id: receiptId, line_number: i + 1, classification: mismatch ? "mismatched" : "matched",
        quantity: null, line_status: outstanding ? "outstanding" : "verified", variance_percentage: mismatch ? -0.25 : null,
        review_note: null, explanation: mismatch ? r.mismatch! : null, ...stamps(r.day, "receipt"),
      };
    }));
    event(r.day, "receipt", jordan, TRANSFER_RECEIPT_RECORD, { receiptId, version: 1, partial: r.partial != null, lineCount: r.lines });
  }
  if (m.feeReimbursement && m.funded) {
    const d = later(m.feeReimbursement, m.funded.day);
    const recordId = insert("transfer_fee_reimbursement", { id: idOf("fee-reimbursement"), transfer_id: m.transferId, evidenced: true, ...stamps(d, "fee") });
    event(d, "fee", jordan, TRANSFER_FOLLOW_UP_RECORD, { recordId, kind: "fee_reimbursement" });
  }
  if (m.residual && m.submission) {
    const recordId = insert("transfer_residual", {
      id: idOf("residual"), transfer_id: m.transferId, original_control_number: m.submission.control, tracker_stage: m.residual.trackerStage,
      ...stamps(m.residual.day, "residual"),
    });
    event(m.residual.day, "residual", jordan, TRANSFER_FOLLOW_UP_RECORD, { recordId, kind: "residual", hasTrackerStage: true });
  }
  if (m.outcome) {
    writes.push(actAs(helen));
    const recordId = insert("transfer_outcome", {
      id: idOf("outcome"), transfer_id: m.transferId, outcome: m.outcome.outcome, reason: m.outcome.reason,
      follow_up_on: m.outcome.followUpOn ? day(m.outcome.followUpOn) : null, outcome_on: day(m.outcome.day),
      resumed: false, ...stamps(m.outcome.day, "outcome"),
    });
    event(m.outcome.day, "outcome", helen, TRANSFER_OUTCOME_RECORD, { recordId, kind: "outcome", outcome: m.outcome.outcome });
  }

  // --- the checklist: each stage's defaults as the stage was entered, then the extra tasks people added ---

  writes.push(actAs(helen));
  const tasks = checklist(m, helen, jordan);
  const taskIds = tasks.map((_, i) => `${m.transferId}-task-${i + 1}`);
  insert("transfer_task", ...tasks.map((t, sort) => ({
    id: taskIds[sort],
    transfer_id: m.transferId, title: t.title, sort_order: sort, done: t.done != null,
    override_done: t.override ? true : null,
    completed_at: t.done ? at(t.done.day, `task-${t.title}`) : null, completed_by: t.done?.by.email ?? null,
    status: t.done ? "Completed" : t.status, team: t.team, assigned_to: t.assignedTo ?? null,
    follow_up_on: t.followUpOn ? day(t.followUpOn) : null,
    created_at: at(t.created, `task-${t.title}`), updated_at: at(t.done?.day ?? t.created, `task-${t.title}`),
  })));
  for (const [i, t] of tasks.entries()) {
    if (t.done) event(t.done.day, `task-${t.title}`, t.done.by, TRANSFER_TASK_TOGGLE, { taskId: taskIds[i], done: true });
    if (t.extra) event(t.created, `added-${t.title}`, t.addedBy ?? helen, TRANSFER_UPDATE, { addedTaskId: taskIds[i] });
  }

  // --- the Slack closeout, seeded when the transfer entered In transfer ---

  if (m.inTransfer && m.fundingType !== "DRS" && !m.achInitiation) {
    writes.push(actAs(m.inTransfer.by));
    const inTransfer = m.inTransfer;
    const posted = new Date(at(inTransfer.day, "in-transfer").getTime() + 2 * 60_000);
    const doneDays = (i: number) => addBusinessDays(m.funded?.day ?? inTransfer.day, Math.min(i, 3));
    const complete = m.closeoutDone >= SLACK_CLOSEOUT_TEMPLATE.length;
    insert("transfer_slack_closeout", {
      id: idOf("slack-closeout"), transfer_id: m.transferId, channel: "C0DEMOXFERS",
      message_ts: `${Math.floor(posted.getTime() / 1000)}.${String(seededInt(`${m.key}:ts`, 100000, 999999))}`,
      status: complete ? "COMPLETE" : "PENDING", posted_at: posted,
      completed_at: complete ? at(doneDays(SLACK_CLOSEOUT_TEMPLATE.length - 1), "closeout-done") : null,
      created_at: at(inTransfer.day, "in-transfer"), updated_at: posted,
    });
    insert("transfer_slack_item", ...SLACK_CLOSEOUT_TEMPLATE.map((item, i) => {
      const done = i < m.closeoutDone;
      return {
        id: idOf("slack-item", i + 1), transfer_id: m.transferId, item_key: item.item_key, label: item.label, sort: item.sort, done,
        done_by: done ? (jordan.email ?? null) : null, done_at: done ? at(doneDays(i), `closeout-${i}`) : null,
        created_at: at(inTransfer.day, "in-transfer"), updated_at: done ? at(doneDays(i), `closeout-${i}`) : at(inTransfer.day, "in-transfer"),
      };
    }));
    if (complete) {
      event(doneDays(SLACK_CLOSEOUT_TEMPLATE.length - 1), "closeout-done", { email: null, role: "INGEST", name: "slack" },
        TRANSFER_SLACK_CLOSEOUT, { status: "COMPLETE", items: SLACK_CLOSEOUT_TEMPLATE.length });
    }
  }

  // --- the audit trail, in the order it happened ---

  const rows = events
    .map((e) => ({ ...e, at: at(e.day, e.key) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.at.getTime() - b.at.getTime());
  writes.push(insertWrite('audit."AuditLog"', rows.map((e) => ({
    at: e.at, actorEmail: e.actor.email, actorRole: e.actor.role, action: e.action, entityType: "transfer",
    entityId: m.transferId, detail: JSON.stringify(e.detail),
  }))));
  return { writes, tasks: tasks.length, audit: rows.length };
}

type PlannedTask = {
  title: string;
  team: string;
  status: "Ready" | "Waiting";
  created: string;
  done?: { day: string; by: Actor };
  override?: boolean;
  assignedTo?: string;
  followUpOn?: string;
  extra?: boolean;
  addedBy?: Actor;
};

/** The checklist each stage seeded (createTransfer, setStage), with what has been done and by whom. */
function checklist(m: Movement, helen: Actor, jordan: Actor): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  const add = (title: string, created: string, done?: { day: string; by: Actor }, extra: Partial<PlannedTask> = {}) =>
    tasks.push({ title, team: TASK_TEAM[title] ?? "Operations", status: "Ready", created, done, ...extra });
  const acat = m.fundingType === "ACAT_FULL" || m.fundingType === "ACAT_PARTIAL";
  const partial = m.fundingType === "ACAT_PARTIAL";
  const extraTitles = new Set(m.extraTasks.map((t) => t.title));

  for (const title of DEFAULT_TASKS.DECISION) {
    switch (title) {
      case "Collect statements":
        // Synced to the deal's statements flag; a waiting extra task of the same name stands in for it.
        if (extraTitles.has(title)) break;
        add(title, m.created, m.statement?.accepted ? { day: m.statement.day, by: helen } : undefined);
        break;
      case "Run asset mapper":
        add(title, m.created, m.plan ? { day: m.plan.day, by: jordan } : undefined, acat ? {} : { override: m.plan != null });
        break;
      // Seeded on every transfer but needed only for a partial ACAT; Operations ticks them off with the plan otherwise.
      case "Send decision worksheet":
        add(title, m.created, partial ? (m.plan || m.worksheet ? { day: m.statement?.day ?? m.created, by: helen } : undefined)
          : m.plan ? { day: m.plan.day, by: jordan } : undefined);
        break;
      case "Asset decisions finalized":
        add(title, m.created, m.plan ? { day: m.plan.day, by: jordan } : undefined);
        break;
      case "Open receiving accounts": {
        const opened = m.newReceiving ? m.newReceiving.open : m.receivingOpen;
        add(title, m.created, opened ? { day: opened, by: helen } : undefined, opened ? {} : { status: "Waiting", assignedTo: helen.name, followUpOn: addBusinessDays(m.created, 3) });
        break;
      }
      case "Confirm account numbers":
        add(title, m.created, m.match && m.plan ? { day: m.match, by: jordan } : undefined);
        break;
      default:
        add(title, m.created);
    }
  }
  // ACH moves itself In transfer through the client's initiation, which seeds no stage checklist; DRS runs its own
  // steps and never seeds one.
  if (m.inTransfer && m.fundingType !== "DRS" && !m.achInitiation) {
    const d = m.inTransfer.day;
    const settled = m.funded?.day ?? (m.receipt && !m.receipt.partial ? m.receipt.day : undefined);
    for (const title of DEFAULT_TASKS.IN_TRANSFER) {
      if (title === "ACAT submitted to Apex") add(title, d, { day: d, by: m.inTransfer.by });
      else if (title === "Transfer accepted by contra") add(title, d, m.accepted || m.funded ? { day: m.accepted ?? m.funded!.day, by: jordan } : undefined);
      else if (title === "Positions settling") add(title, d, settled ? { day: settled, by: jordan } : undefined);
      else add(title, d, settled ? { day: settled, by: jordan } : undefined);
    }
  }
  if (m.funded && m.fundingType !== "DRS") {
    const d = m.funded.day;
    DEFAULT_TASKS.FUNDED.forEach((title, i) => {
      const done = i < m.fundedTasksDone ? { day: addBusinessDays(d, Math.min(i, 2)), by: jordan } : undefined;
      add(title, d, done, done ? {} : { assignedTo: jordan.name, followUpOn: addBusinessDays(d, 3 + i) });
    });
  }
  for (const t of m.extraTasks) {
    tasks.push({
      title: t.title, team: t.team, status: t.status, created: t.day, assignedTo: t.assignedTo, followUpOn: t.followUpOn,
      done: t.doneDay ? { day: t.doneDay, by: helen } : undefined, extra: true,
      addedBy: t.team === "Operations" ? jordan : helen,
    });
  }
  return tasks;
}
