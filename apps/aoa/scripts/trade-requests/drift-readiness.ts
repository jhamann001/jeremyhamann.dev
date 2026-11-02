import { PrismaClient } from "@prisma/client";
import { runDriftReadiness } from "../../lib/trade-requests/drift/readiness";

// ticket: compares the five most recent weekday AOA shadow drift runs with the standalone service's live
// results and records the verdict. Prints one JSON line (run id, verdict, per-date counts). Exit 0 ready,
// 1 not ready or failed, 2 usage.
async function main(): Promise<void> {
  const standaloneUrl = process.env.TRADE_REQUEST_SOURCE_DATABASE_URL;
  const aoaUrl = process.env.DIRECT_DATABASE_URL;
  if (!standaloneUrl || !aoaUrl) {
    console.error("TRADE_REQUEST_SOURCE_DATABASE_URL and DIRECT_DATABASE_URL are required");
    process.exitCode = 2;
    return;
  }
  const standalone = new PrismaClient({ datasourceUrl: standaloneUrl });
  const aoa = new PrismaClient({ datasourceUrl: aoaUrl });
  try {
    const result = await runDriftReadiness({ aoa, standalone, actor: process.env.USER ?? "operator" });
    console.log(JSON.stringify(result));
    if (result.verdict !== "ready") process.exitCode = 1;
  } finally {
    await standalone.$disconnect();
    await aoa.$disconnect();
  }
}

main().catch((err: unknown) => {
  // Never the message: a database error can echo a value.
  const code = (err as { code?: unknown })?.code;
  console.error(JSON.stringify({ error: err instanceof Error ? err.name : "drift_readiness_failed", code: typeof code === "string" ? code : null }));
  process.exitCode = 1;
});
