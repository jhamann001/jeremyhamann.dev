import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({source:vi.fn(),targets:vi.fn(),persist:vi.fn(),saved:null as any}));
vi.mock("@/auth",()=>({auth:async()=>({user:{role:"OPERATIONS",email:"ops@example.invalid"}})}));
vi.mock("@/lib/rls",()=>({withUserScope:async(_id:unknown,fn:(tx:unknown)=>unknown)=>fn({})}));
vi.mock("@/lib/data/acat-match-source",async actual=>({...await actual<typeof import("@/lib/data/acat-match-source")>(),fetchTransferLinkageSnapshot:m.source,readAcatCandidatesWithinScope:m.targets}));
vi.mock("@/lib/data/acat-auto-link",()=>({readAcatRejectedPairsWithinScope:async()=>[]}));
vi.mock("@/lib/data/acat-reconciliation/persistence",()=>({prepareReconciliationRun:m.persist}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("next/navigation",()=>({redirect:(url:string)=>{throw Error(`REDIRECT:${url}`)}}));
import {prepareAcatReview} from "@/app/(authenticated)/acat-link-review/actions";
import {prepareHistoricalAcatManifest,makeHistoricalAcatIntent} from "@/lib/data/acat-historical-review";
import {acatEvidenceHash,matchAcatPopulation} from "@/lib/data/acat-match";
import type { Prisma } from "@prisma/client";
import {facts,NOW} from "./legacy-fixtures";
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(NOW);vi.stubEnv("ACAT_LINK_REVIEW","1");vi.stubEnv("AOA_WRITES_PAUSED","0");
 m.persist.mockImplementation(async(_tx,_id,p)=>{m.saved=p;return{runId:"synthetic-run"}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()});
describe("generic and historical preparation do not silently reopen initial scope",()=>{
 it("generic Prepare review produces no legacy proposal",async()=>{
  const f=facts();m.source.mockResolvedValue(f.source);m.targets.mockResolvedValue([f.target]);
  await expect(prepareAcatReview()).rejects.toThrow("run=synthetic-run&message=prepared");
  expect(m.saved.manifest.decisions.find((d:any)=>d.transferId===f.target.transferId)).toMatchObject({action:"review",reason:"ineligible_lifecycle"});
 });
 it("historical preparation authorizes only the selected pair, not unrelated legacy targets",()=>{
  const f=facts("legacy",true),other=facts();other.record.recordId="synthetic-other-record";
  other.record.acatTransferId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";other.record.recordEvidenceDigest=acatEvidenceHash(other.record);
  other.target.transferId="synthetic-other-transfer";other.target.existingTransferUuid=other.record.acatTransferId;
  other.target.transactionReference={namespace:"apex-acat-transfer",value:other.record.acatTransferId,provenance:"EXISTING_LINK"};
  other.target.evidenceDigest=acatEvidenceHash(other.target);f.source.records.push(other.record);f.source.recordCount++;
  f.source.snapshotDigest=acatEvidenceHash({contractVersion:f.source.contractVersion,source:f.source.source,scope:f.source.scope,
   records:[...f.source.records].sort((a,b)=>a.recordId.localeCompare(b.recordId)).map(x=>[x.recordId,x.recordEvidenceDigest,x.accountEvidenceDigest])});
  const prepared=prepareHistoricalAcatManifest({snapshot:f.source,targets:[f.target,other.target],rejectedPairs:[],intent:makeHistoricalAcatIntent([],[]),now:NOW,
   selection:{transferId:f.target.transferId,recordId:f.record.recordId,historicalConfirmed:"yes",expectedTargetVersion:0,expectedTargetDigest:f.target.evidenceDigest,
    expectedSourceDigest:f.source.snapshotDigest,evidenceKind:"TRANSACTION_REFERENCE",evidenceReference:f.record.acatTransferId!,
    correspondence:"Operations independently reviewed the original confirmation and verified the exact transfer correspondence."}});
  expect(prepared.manifest.decisions.find(d=>d.transferId===f.target.transferId)).toMatchObject({action:"review",payload:{historicalReview:{kind:"HISTORICAL_ACAT_REVIEW"}}});
  expect(prepared.manifest.decisions.find(d=>d.transferId===other.target.transferId)).toMatchObject({action:"review",reason:"ineligible_lifecycle"});
  expect(prepared.summary.aoa.total).toBe(2);expect(prepared.summary.tracker.total).toBe(2);
  expect(prepared.manifest.decisions.some(d=>d.action==="propose")).toBe(false);
 });
});

describe("reachable current AOA adapter authority",()=>{
 it("does not manufacture VERIFIED authority from existing UUID, CRM reference or no reference",async()=>{
  const f=facts(),base={acat_link_version:0,acat_record_id:null,acat_auto_link_hold:false,stage:"IN_TRANSFER",funding_type:"ACAT_FULL",archived_at:null,
   client_user_ids:f.record.cedarRidgeUserIds,deal_user_id:f.record.cedarRidgeUserIds[0]};
  const tx={$queryRaw:vi.fn().mockResolvedValue([
   {...base,id:"synthetic-existing",acat_transfer_id:f.record.acatTransferId,deal_sf_id:null},
   {...base,id:"synthetic-crm",acat_transfer_id:null,deal_sf_id:"006288867315530AAA"},
   {...base,id:"synthetic-none",acat_transfer_id:null,deal_sf_id:null}])};
  const {readAcatCandidatesWithinScope}=await vi.importActual<typeof import("@/lib/data/acat-match-source")>("@/lib/data/acat-match-source");
  expect(readAcatCandidatesWithinScope).not.toBe(m.targets);
  const rows=await readAcatCandidatesWithinScope(tx as unknown as Prisma.TransactionClient);
  expect(tx.$queryRaw).toHaveBeenCalledOnce();
  expect(m.targets).not.toHaveBeenCalled();
  expect(rows.map(r=>r.transactionReference?.provenance??null)).toEqual(["EXISTING_LINK","LEGACY_UNVERIFIED",null]);
  expect(rows.every(r=>r.receivingAccount===null)).toBe(true);
  expect(matchAcatPopulation(f.source,rows,{now:NOW}).filter(r=>r.action==="propose")).toHaveLength(0);
 });
});
