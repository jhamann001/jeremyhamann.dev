import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ targets: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAudit: mocks.audit, ACAT_LINK_APPLY: "acat_link.apply",
  ACAT_LINK_HOLD: "acat_link.hold", ACAT_LINK_UNDO: "acat_link.undo", TRANSFER_CREATE: "transfer.create", TRANSFER_UPDATE: "transfer.update" }));
vi.mock("@/lib/data/acat-match-source", async (actual) => ({ ...await actual<typeof import("@/lib/data/acat-match-source")>(),
  readAcatCandidatesWithinScope: mocks.targets }));
import { applyAcatDecisionWithinScope, undoAcatDecisionWithinScope } from "@/lib/data/acat-auto-link";
import { facts, NOW } from "./legacy-fixtures";
import { makeHistoricalAcatIntent, prepareHistoricalAcatManifest } from "@/lib/data/acat-historical-review";
import { makeAcatMatchDecision, acatEvidenceHash, matchAcatPopulation } from "@/lib/data/acat-match";

function prepared(mode: "automatic" | "reviewed", kind: "legacy" | "verified" | "human" = "legacy", terminal = false, historical = false) {
 const f=facts(kind==="human"?"verified":kind,terminal);
 if(kind==="human") { f.target.transactionReference=null;f.target.evidenceDigest=acatEvidenceHash(f.target);
   f.decision=makeAcatMatchDecision(f.source,f.target,f.record,"missing_transaction_evidence","review"); }
 const paired=historical?prepareHistoricalAcatManifest({snapshot:f.source,targets:[f.target],rejectedPairs:[],
  intent:makeHistoricalAcatIntent([],[]),now:NOW,selection:{transferId:f.target.transferId,recordId:f.record.recordId,historicalConfirmed:"yes",
   expectedTargetVersion:0,expectedTargetDigest:f.target.evidenceDigest,expectedSourceDigest:f.source.snapshotDigest,
   evidenceKind:"TRANSACTION_REFERENCE",evidenceReference:f.record.acatTransferId!,
   correspondence:"Operations reviewed the original transfer confirmation and established exact transfer correspondence."}}).manifest.decisions.find(x=>x.transferId===f.target.transferId)!:null;
 const d=paired?Object.fromEntries(Object.entries(paired).filter(([k])=>!["decisionKey","payload"].includes(k))) as typeof f.decision:f.decision;
 expect(d.action).toBe(historical||kind==="human"?"review":"propose");
 const stored={ id:"synthetic-decision",transfer_id:d.transferId,record_id:d.recordId,reason:d.reason,action:d.action,
  rule_version:d.ruleVersion,expected_target_version:d.targetVersion,target_evidence_digest:d.targetDigest,
  evidence_digest:d.evidenceDigest,source_candidate_set_digest:d.sourceCandidateSetDigest,review_version:0,
  disposition:mode==="reviewed"?"ACCEPT":"PENDING",reviewed_by:mode==="reviewed"?"ops@example.invalid":null,
  reviewed_at:mode==="reviewed"?NOW:null,outcome:"PENDING",applied_version:null as number|null,
  payload:{ decision:d,context:paired?.payload??{targetBefore:{recordId:null,transferUuid:f.target.existingTransferUuid,hold:false}} },
  run:{mode:mode==="reviewed"?"PREPARE":"AUTOMATIC",rule_version:d.ruleVersion,source_complete:true,
   source_scope:f.source.scope,source_digest:f.source.snapshotDigest,installation_id:f.source.source.installationId,
   source_boundary:{source:f.source.source} } };
 const row={id:f.target.transferId,acat_link_version:0,acat_record_id:null as string|null,acat_transfer_id:f.target.existingTransferUuid,
  acat_auto_link_hold:false,acat_link_provenance:null as string|null,acat_link_decision_id:null as string|null,
  stage:f.target.stage,funding_type:"ACAT_FULL",actual_amount:12345,expected_amount:12345,archive_flag:false};
 const business=()=>({stage:row.stage,funding_type:row.funding_type,actual_amount:row.actual_amount,expected_amount:row.expected_amount,archive_flag:row.archive_flag});
 const before=business();
 const tx={auditEvent:{findMany:vi.fn().mockResolvedValue([])},rowChange:{findMany:vi.fn().mockResolvedValue([])},acatLinkReviewEvent:{findMany:vi.fn().mockResolvedValue([])},$executeRaw:vi.fn(),$queryRaw:vi.fn().mockResolvedValue([]),acatLinkDecision:{findUnique:vi.fn().mockResolvedValue(stored),
  findMany:vi.fn().mockResolvedValue([]),update:vi.fn(async({data})=>Object.assign(stored,data)),updateMany:vi.fn().mockResolvedValue({count:1})},
  transfer:{findFirst:vi.fn().mockResolvedValue(null),findUnique:vi.fn(async()=>row),updateMany:vi.fn(async({where,data})=>{
   if(where.acat_link_version!==row.acat_link_version||where.acat_record_id!==row.acat_record_id||where.acat_transfer_id!==row.acat_transfer_id)return{count:0};
   Object.assign(row,data);row.acat_link_version++;return{count:1};})}};
 mocks.targets.mockImplementation(async()=>[{...f.target,linkVersion:row.acat_link_version,existingRecordId:row.acat_record_id,
   existingTransferUuid:row.acat_transfer_id,hold:row.acat_auto_link_hold}]);
 const identity=mode==="reviewed"?{role:"OPERATIONS" as const,email:"ops@example.invalid"}:{role:"INGEST" as const,email:null};
 const apply=()=>applyAcatDecisionWithinScope(tx as unknown as Prisma.TransactionClient,identity,
  {decisionId:stored.id,mode,expectedReviewVersion:0,snapshot:f.source,now:NOW});
 return {...f,stored,row,tx,identity,apply,business,before};
}
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(NOW);vi.stubEnv("AOA_WRITES_PAUSED","0");});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("legacy scope at the actual guarded application boundary",()=>{
 it.each([false,true])("rejects a saved recurring legacy proposal (terminal=%s) without link or apply-audit writes",async terminal=>{
  const f=prepared("automatic","legacy",terminal);const result=await f.apply();
  expect(result).toMatchObject({outcome:"CONFLICT",reason:"ineligible_lifecycle"});
  expect(f.tx.transfer.updateMany).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();expect(f.business()).toEqual(f.before);
 });
 it("keeps a separately verified open transaction eligible for automatic application",async()=>{
  const f=prepared("automatic","verified");expect(await f.apply()).toMatchObject({outcome:"APPLIED"});
  expect(f.row.acat_link_provenance).toBe("AUTOMATIC");expect(f.row.acat_auto_link_hold).toBe(false);
  expect(mocks.audit).toHaveBeenCalledOnce();expect(f.business()).toEqual(f.before);
 });
 it.each([false,true])("rejects generic accepted legacy proposals without initial scope or historical context (terminal=%s)",async terminal=>{
  const f=prepared("reviewed","legacy",terminal);expect(await f.apply()).toMatchObject({outcome:"CONFLICT",reason:"historical_review_required"});
  expect(f.tx.transfer.updateMany).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 });
 it.each([false,true])("preserves the dedicated explicitly accepted HISTORICAL pair and conditional undo (terminal=%s)",async terminal=>{
  const f=prepared("reviewed","legacy",terminal,true);expect(await f.apply()).toMatchObject({outcome:"APPLIED"});
  expect(f.row.acat_link_provenance).toBe("REVIEWED");expect(f.row.acat_auto_link_hold).toBe(true);
  expect(mocks.audit).toHaveBeenCalledOnce();expect(f.business()).toEqual(f.before);
  expect(await undoAcatDecisionWithinScope(f.tx as unknown as Prisma.TransactionClient,f.identity,
   {decisionId:f.stored.id,identity:f.identity,expectedReviewVersion:0})).toMatchObject({outcome:"UNDONE"});
  expect(f.row.acat_record_id).toBeNull();expect(f.row.acat_transfer_id).toBe(f.target.existingTransferUuid);
  expect(f.row.acat_auto_link_hold).toBe(true);expect(f.business()).toEqual(f.before);
 });
 it("preserves ordinary accepted open, no-existing-UUID human pairs",async()=>{
  const f=prepared("reviewed","human");expect(await f.apply()).toMatchObject({outcome:"APPLIED"});
  expect(f.row.acat_link_provenance).toBe("REVIEWED");expect(f.row.acat_auto_link_hold).toBe(true);expect(f.business()).toEqual(f.before);
 });
 it("keeps existing successfully applied automatic legacy decisions as idempotent NOOP",async()=>{
  const f=prepared("automatic");f.stored.outcome="APPLIED";f.stored.applied_version=1;
  Object.assign(f.row,{acat_link_version:1,acat_record_id:f.record.recordId,acat_link_decision_id:f.stored.id,acat_link_provenance:"AUTOMATIC"});
  expect(await f.apply()).toMatchObject({outcome:"NOOP"});expect(f.tx.transfer.updateMany).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 });
 it("does not turn pending human review into approval",async()=>{
  const f=prepared("reviewed");f.stored.disposition="PENDING";
  expect(await f.apply()).toMatchObject({outcome:"CONFLICT",reason:"not_approved"});expect(f.tx.transfer.updateMany).not.toHaveBeenCalled();
 });
 it("preserves archived reservations even in human legacy review",async()=>{
  const f=prepared("reviewed");mocks.targets.mockResolvedValue([f.target,{...f.target,transferId:"archived-reservation",archived:true,existingRecordId:f.record.recordId}]);
  expect(await f.apply()).toMatchObject({outcome:"CONFLICT",reason:"reserved_link"});expect(f.tx.transfer.updateMany).not.toHaveBeenCalled();
 });
 it("keeps the pure matcher initial-scope opt-in available only to explicit callers",()=>{
  const f=facts();expect(matchAcatPopulation(f.source,[f.target],{now:NOW})[0].action).toBe("review");
  expect(matchAcatPopulation(f.source,[f.target],{now:NOW,allowLegacyEnrichment:true})[0].action).toBe("propose");
 });
});
