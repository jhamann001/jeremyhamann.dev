import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { DRS_TASKS, drsTasksForStage } from "@/lib/data/drs-workflow";
import { parseCrmReportQuery } from "@/lib/crm/reporting-query";

const RUN = process.env.DRS_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "TEST-DRS-PROGRESS";
const OWNER = "DRS Progress Synthetic Owner";
const OPS = { role: "OPERATIONS", email: "drs-progress@example.test" };
const IDS = ["prep", "movement", "missing", "cs-open", "ops-open", "complete", "wire"]
  .map((key) => `${PREFIX}-${key}`);

// Explicit local synthetic connections only; never use an ambient application DB.
function syntheticUrl(raw: string | undefined, roles: string[]): URL {
  if (!raw) throw new Error("explicit_drs_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "55439" || url.pathname !== "/aoa_drs_synthetic"
    || !roles.includes(url.username)
    || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
    || url.hash || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_drs_synthetic_database_required");
  }
  return url;
}

RUN("DRS board and reporting progress uses owned workflow tasks", () => {
  let owner: PrismaClient;
  let listTransfers: typeof import("@/lib/data/transfers").listTransfers;
  let getCrmReportingDatasets: typeof import("@/lib/data/crm-reporting").getCrmReportingDatasets;
  let appPrisma: typeof import("@/lib/db").prisma;
  const priorReporting = process.env.CRM_REPORTING;

  async function cleanup() {
    await owner.decisionTask.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferTask.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transfer.deleteMany({ where: { id: { in: IDS } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = syntheticUrl(process.env.DRS_TEST_DATABASE_URL, ["app_rw"]).toString();
    owner = new PrismaClient({ datasourceUrl: syntheticUrl(process.env.DRS_TEST_CLEANUP_URL, ["aoa", "postgres"]).toString() });
    ({ listTransfers } = await import("@/lib/data/transfers"));
    ({ getCrmReportingDatasets } = await import("@/lib/data/crm-reporting"));
    ({ prisma: appPrisma } = await import("@/lib/db"));
    await cleanup();
    process.env.CRM_REPORTING = "1";
    for (const [index, id] of IDS.entries()) {
      await owner.transfer.create({ data: {
        id, source: "APP", client_first_name: "Synthetic", client_last_name: "DRS Progress",
        value: 10, owner_kind: "OPERATIONS", owner_name: OWNER,
        funding_type: index === 6 ? "WIRE" : "DRS",
        stage: index === 0 ? "DECISION" : index === 1 ? "IN_TRANSFER" : "FUNDED",
        tasks: { create: [{ title: "Legacy checklist must not count for DRS", sort_order: 0, done: ![5, 6].includes(index) }] },
      } });
      if (index === 2) continue; // A legacy funded DRS row has no new tasks yet.
      for (const task of DRS_TASKS) {
        if (index === 0 && !["paperwork", "statement"].includes(task.key)) continue;
        const done = index === 0 ? task.key === "paperwork" :
          index === 1 ? false : index === 3 ? task.key !== "client-communication" :
            index === 4 ? task.key !== "reconciliation" : true;
        await owner.decisionTask.create({ data: {
          source_key: `asset-transfer:${id}:drs:${task.key}`, transfer_id: id,
          task_key: task.taskKey, title: task.title, owner_team: task.ownerTeam,
          status: done ? "DONE" : "TODO",
          completed_at: done ? new Date() : null, completed_by: done ? OPS.email : null,
        } });
      }
      // Same task key and an unrelated direct task must neither count nor fan out value.
      await owner.decisionTask.create({ data: {
        source_key: `unrelated:${id}`, transfer_id: id, task_key: "drs-paperwork",
        title: "Unrelated private task text", owner_team: "OPERATIONS", status: "DONE",
        completed_at: new Date(), completed_by: OPS.email,
      } });
      if (index === 0) await owner.decisionTask.create({ data: {
        source_key: `asset-transfer:${id}:drs:receiving-account`, transfer_id: id,
        task_key: "drs-receiving-account", title: "Wrong owner must not count",
        owner_team: "ADVISORY", status: "DONE",
        completed_at: new Date(), completed_by: OPS.email,
      } });
    }
  });

  afterAll(async () => {
    if (priorReporting == null) delete process.env.CRM_REPORTING;
    else process.env.CRM_REPORTING = priorReporting;
    if (owner) { await cleanup(); await owner.$disconnect(); }
    if (appPrisma) await appPrisma.$disconnect();
  });

  it.each([false, true])("counts expected DRS phase tasks with stage-checklist mode %s", async (currentStageChecklistOnly) => {
    const rows = await listTransfers(OPS, { currentStageChecklistOnly });
    const get = (key: string) => rows.find((row) => row.id === `${PREFIX}-${key}`);
    expect(get("prep")).toMatchObject({ tasksDone: 1, tasksTotal: 5,
      nextIncompleteTask: drsTasksForStage("DECISION")[1].title, value: 10 });
    expect(get("movement")).toMatchObject({ tasksDone: 0, tasksTotal: 3,
      nextIncompleteTask: drsTasksForStage("IN_TRANSFER")[0].title });
    expect(get("missing")).toMatchObject({ tasksDone: 0, tasksTotal: 2,
      nextIncompleteTask: drsTasksForStage("FUNDED")[0].title });
    expect(get("cs-open")).toMatchObject({ tasksDone: 1, tasksTotal: 2,
      nextIncompleteTask: drsTasksForStage("FUNDED")[1].title });
    expect(get("ops-open")).toMatchObject({ tasksDone: 1, tasksTotal: 2,
      nextIncompleteTask: drsTasksForStage("FUNDED")[0].title });
    expect(get("complete")).toMatchObject({ tasksDone: 2, tasksTotal: 2, nextIncompleteTask: null });
    if (!currentStageChecklistOnly) expect(get("wire")).toMatchObject({ tasksDone: 0, tasksTotal: 1 });
  });

  it.each([false, true])("keeps incomplete/missing DRS followups visible with stage-checklist mode %s", async (currentStageChecklistOnly) => {
    const ids = (await listTransfers(OPS, { hideCompletedFunded: true, currentStageChecklistOnly })).map((row) => row.id);
    for (const key of ["missing", "cs-open", "ops-open"]) expect(ids).toContain(`${PREFIX}-${key}`);
    expect(ids).not.toContain(`${PREFIX}-complete`);
  });

  it("uses the same DRS open counts in reporting without multiplying transfer values or exposing task data", async () => {
    const result = await getCrmReportingDatasets(OPS, parseCrmReportQuery({ dataset: "transfers_funding", owner: OWNER }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.datasets[0].rows.filter((row) => row.owner === OWNER);
    expect(rows.find((row) => row.fundingType === "DRS" && row.stage === "Decision"))
      .toMatchObject({ transfers: 1, transferValue: 10, openChecklistItems: 4 });
    expect(rows.find((row) => row.fundingType === "DRS" && row.stage === "In Transfer"))
      .toMatchObject({ transfers: 1, transferValue: 10, openChecklistItems: 3 });
    expect(rows.find((row) => row.fundingType === "DRS" && row.stage === "Funded"))
      .toMatchObject({ transfers: 4, transferValue: 40, openChecklistItems: 4 });
    expect(rows.find((row) => row.fundingType === "Wire"))
      .toMatchObject({ transfers: 1, transferValue: 10, openChecklistItems: 1 });
    expect(JSON.stringify(rows)).not.toContain("Unrelated private task text");
    expect(JSON.stringify(rows)).not.toContain(PREFIX);
  });
});
