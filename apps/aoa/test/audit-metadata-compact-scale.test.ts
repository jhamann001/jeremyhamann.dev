import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { Prisma,PrismaClient } from "@prisma/client";
const captured=vi.hoisted(()=>({sql:[] as Prisma.Sql[]}));
vi.mock("@/lib/rls",async importOriginal=>{
  const original=await importOriginal<typeof import("@/lib/rls")>();
  return {...original,withUserScope:(identity:Parameters<typeof original.withUserScope>[0],
    fn:Parameters<typeof original.withUserScope>[1],options:Parameters<typeof original.withUserScope>[2])=>
    original.withUserScope(identity,async tx=>{
      await tx.$executeRaw`SELECT set_config('max_parallel_workers_per_gather','0',true)`;
      return fn(new Proxy(tx,{get(target,key){
      if(key!=="$queryRaw")return Reflect.get(target,key);
      return(sql:Prisma.Sql)=>{captured.sql.push(sql);return target.$queryRaw(sql);};
    }}));},options)};
});
import { getRowChangeMetadata,listRowChanges } from "@/lib/data/row-changes";
import { withUserScope } from "@/lib/rls";
import { applyAuditReadDatabaseBounds,AUDIT_READ_TRANSACTION_OPTIONS } from "@/lib/data/audit-read-bounds";

const benchmark=process.env.AUDIT_COMPACT_METADATA_SCALE==="1"?describe:describe.skip;
const OPS={role:"OPERATIONS",email:"audit-compact@example.invalid"};
benchmark("exact compact metadata over10M invented history rows",()=>{
  let owner:PrismaClient;
  beforeAll(()=>{
    const ownerRaw=process.env.AUDIT_TEST_CLEANUP_URL,readerRaw=process.env.DATABASE_URL;
    if(!ownerRaw||!readerRaw)throw new Error("explicit_synthetic_database_required");
    for(const [value,username] of [[ownerRaw,"aoa"],[readerRaw,"app_rw"]]){
      const url=new URL(value);
      if(!["postgres:","postgresql:"].includes(url.protocol)||url.hostname!=="127.0.0.1"||url.port!=="55444"
        ||url.pathname!=="/aoa_audit_scale_synthetic"||url.username!==username
        ||[...url.searchParams.keys()].some(key=>!["schema","connection_limit","pool_timeout"].includes(key))
        ||process.env.K_SERVICE||process.env.CLOUD_RUN_SERVICE||["prod","production","dev","development"].includes(process.env.APP_ENV??"")){
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner=new PrismaClient({datasourceUrl:ownerRaw});
  });
  afterAll(async()=>{
    if(owner){await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'SCMP-SYN-%'`;await owner.$disconnect();}
  });
  it("proves every exact facet/count against legacy and measures the naturally selected compact index",async()=>{
    const timings:unknown[]=[];
    const beforeStart=performance.now();
    const legacy=await listRowChanges(OPS,{pageSize:100});
    const legacyMs=performance.now()-beforeStart;
    if(!legacy.ok)throw new Error("expected_access");
    expect(legacy.total).toBeGreaterThanOrEqual(10_000_000);
    captured.sql=[];
    const start=performance.now(),current=await getRowChangeMetadata(OPS),currentMs=performance.now()-start;
    expect(current).toEqual({ok:true,total:legacy.total,tables:legacy.tables,ops:legacy.ops,actors:legacy.actors});
    const sql=captured.sql[0];
    for(const query of [{table:legacy.tables[0]},{op:legacy.ops[0],actor:legacy.actors[0]},{table:"SCMP-ABSENT"}]){
      const expected=await listRowChanges(OPS,query);
      if(!expected.ok)throw new Error("expected_access");
      const filterStart=performance.now(),result=await getRowChangeMetadata(OPS,query);
      expect(result).toEqual({ok:true,total:expected.total,tables:expected.tables,ops:expected.ops,actors:expected.actors});
      timings.push({ms:performance.now()-filterStart,total:expected.total});
    }
    const [raw]=await withUserScope(OPS,async tx=>{
      await applyAuditReadDatabaseBounds(tx);
      return tx.$queryRaw<Array<{"QUERY PLAN":Array<Record<string,unknown>>}>>(Prisma.sql`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`);
    },AUDIT_READ_TRANSACTION_OPTIONS);
    const plan=raw["QUERY PLAN"][0],scans:Array<Record<string,unknown>>=[];
    const visit=(node:Record<string,unknown>)=>{
      if(node["Relation Name"])scans.push({type:node["Node Type"],index:node["Index Name"],relation:node["Relation Name"],heapFetches:node["Heap Fetches"],rows:node["Actual Rows"],loops:node["Actual Loops"]});
      for(const child of(node.Plans??[]) as Array<Record<string,unknown>>)visit(child);
    };
    visit(plan.Plan as Record<string,unknown>);
    expect(scans).toContainEqual(expect.objectContaining({type:"Index Only Scan",index:"row_change_table_name_op_actor_email_idx"}));
    process.stdout.write(JSON.stringify({event:"audit_compact_metadata_scale",source:"invented local history; no live latency or cold cache claim",legacyMs,currentMs,timings,executionMs:plan["Execution Time"],scans})+"\n");
  },90_000);
  it("retains MVCC exactness through a pending insert and newly committed non-all-visible pages",async()=>{
    const initial=await getRowChangeMetadata(OPS,{table:"SCMP-SYNTHETIC"});
    expect(initial).toMatchObject({ok:true,total:0});
    await owner.$transaction(async tx=>{
      await tx.$executeRaw`INSERT INTO audit.row_change(schema_name,table_name,op,db_role,row_pk,changed)
        SELECT 'app','SCMP-SYNTHETIC','INSERT','synthetic','SCMP-SYN-'||i,jsonb_build_object('invented',i)
        FROM generate_series(1,1000)i`;
      expect(await getRowChangeMetadata(OPS,{table:"SCMP-SYNTHETIC"})).toMatchObject({ok:true,total:0});
    },{timeout:15_000});
    captured.sql=[];
    const start=performance.now(),after=await getRowChangeMetadata(OPS,{table:"SCMP-SYNTHETIC"});
    const elapsedMs=performance.now()-start,sql=captured.sql[0];
    expect(after).toMatchObject({ok:true,total:1000});
    if(!after.ok)throw new Error("expected_access");
    expect(after.actors).not.toContain(null);
    const [raw]=await withUserScope(OPS,async tx=>{
      await applyAuditReadDatabaseBounds(tx);
      return tx.$queryRaw<Array<{"QUERY PLAN":Array<Record<string,unknown>>}>>(Prisma.sql`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`);
    },AUDIT_READ_TRANSACTION_OPTIONS);
    const scans:Array<Record<string,unknown>>=[];
    const visit=(node:Record<string,unknown>)=>{
      if(node["Relation Name"])scans.push({type:node["Node Type"],index:node["Index Name"],heapFetches:node["Heap Fetches"],reads:node["Shared Read Blocks"],hits:node["Shared Hit Blocks"]});
      for(const child of(node.Plans??[]) as Array<Record<string,unknown>>)visit(child);
    };
    visit(raw["QUERY PLAN"][0].Plan as Record<string,unknown>);
    expect(scans).toContainEqual(expect.objectContaining({type:"Index Only Scan",index:"row_change_table_name_op_actor_email_idx"}));
    expect(scans.some(scan=>Number(scan.heapFetches)>0)).toBe(true);
    process.stdout.write(JSON.stringify({event:"audit_compact_recent_visibility",committedNewRows:1000,ms:elapsedMs,scans})+"\n");
  },30_000);
});
