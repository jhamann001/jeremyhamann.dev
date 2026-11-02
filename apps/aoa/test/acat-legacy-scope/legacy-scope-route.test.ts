import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({source:vi.fn(),targets:vi.fn(),rejected:vi.fn(),persist:vi.fn(),apply:vi.fn(),scope:vi.fn(),audit:vi.fn(),saved:null as any}));
vi.mock("@/lib/data/acat-match-source",()=>({fetchTransferLinkageSnapshot:mocks.source,readAcatCandidatesWithinScope:mocks.targets}));
vi.mock("@/lib/data/acat-auto-link",()=>({applyAcatDecision:mocks.apply,readAcatRejectedPairsWithinScope:mocks.rejected}));
vi.mock("@/lib/data/acat-reconciliation/persistence",()=>({prepareReconciliationRun:mocks.persist}));
vi.mock("@/lib/ingest/scope",()=>({withIngestScope:mocks.scope}));
vi.mock("@/lib/cron/acat-link-auth",()=>({requireAcatLinkCronAuth:async()=>true}));
vi.mock("@/lib/audit",()=>({ACAT_LINK_RUN:"acat_link.run",writeAudit:mocks.audit}));
import { POST } from "@/app/api/cron/acat-link-sync/route";
import { facts,NOW } from "./legacy-fixtures";
const request=(preview=false)=>new Request(`https://synthetic.invalid/api/cron/acat-link-sync${preview?"?mode=preview":""}`,{method:"POST"});
beforeEach(()=>{
 vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(NOW);vi.stubEnv("ACAT_AUTO_LINK","1");vi.stubEnv("ACAT_LINK_REVIEW","1");vi.stubEnv("AOA_WRITES_PAUSED","0");mocks.saved=null;
 mocks.rejected.mockResolvedValue([]);mocks.persist.mockImplementation(async(_tx,_id,p)=>{mocks.saved=p;return{runId:"synthetic-run",created:true};});
 mocks.apply.mockResolvedValue({outcome:"APPLIED"});
 mocks.scope.mockImplementation(async fn=>fn({acatLinkDecision:{findMany:async()=>mocks.saved.manifest.decisions.filter((d:any)=>d.action==="propose").map((_:any,i:number)=>({id:`synthetic-${i}`,review_version:0})),count:async()=>0},acatLinkRun:{update:vi.fn()}}));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("recurring/preview handler with the actual matcher and actual complete-population manifest",()=>{
 it.each([false,true])("does not create recurring legacy proposals, including terminal=%s",async terminal=>{
  const f=facts("legacy",terminal);mocks.source.mockResolvedValue(f.source);mocks.targets.mockResolvedValue([f.target]);
  const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({applied:0});
  expect(mocks.saved.summary.aoa.categories).toMatchObject({proposed:0,pending:1});expect(mocks.saved.summary.tracker.total).toBe(1);
  expect(mocks.apply).not.toHaveBeenCalled();
 });
 it("preview reflects the same automatic policy and makes no durable writes",async()=>{
  const f=facts();mocks.source.mockResolvedValue(f.source);mocks.targets.mockResolvedValue([f.target]);
  const response=await POST(request(true));expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({summary:{aoa:{categories:{proposed:0,pending:1}}}});
  expect(mocks.persist).not.toHaveBeenCalled();expect(mocks.apply).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 });
 it("retains a positive path for a separately verified authoritative reference fixture",async()=>{
  const f=facts("verified");mocks.source.mockResolvedValue(f.source);mocks.targets.mockResolvedValue([f.target]);
  expect(await(await POST(request())).json()).toMatchObject({applied:1});expect(mocks.saved.summary.aoa.categories.proposed).toBe(1);expect(mocks.apply).toHaveBeenCalledOnce();
 });
});
