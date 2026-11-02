import { PrismaClient } from "@prisma/client";
import { CopyRefused, runCopy, type CopyMode } from "../../lib/trade-requests/records/copy-engine";

const MODES: readonly CopyMode[] = ["full", "change", "report", "copy_back"];

async function main(): Promise<void> {
  const raw = process.argv.find((a) => a.startsWith("--mode="))?.slice("--mode=".length).replace("-", "_");
  const mode = MODES.find((m) => m === raw);
  if (!mode) {
    console.error(`usage: tsx scripts/trade-requests/copy.ts --mode=full|change|report|copy-back`);
    process.exitCode = 2;
    return;
  }
  const sourceUrl = process.env.TRADE_REQUEST_SOURCE_DATABASE_URL;
  const targetUrl = process.env.DIRECT_DATABASE_URL;
  if (!sourceUrl || !targetUrl) {
    console.error("TRADE_REQUEST_SOURCE_DATABASE_URL and DIRECT_DATABASE_URL are required");
    process.exitCode = 2;
    return;
  }
  const source = new PrismaClient({ datasourceUrl: sourceUrl });
  const target = new PrismaClient({ datasourceUrl: targetUrl });
  try {
    const result = await runCopy({ source, target, mode, actor: process.env.USER ?? "operator" });
    console.log(JSON.stringify(result));
    if (result.verdict === "blocked") process.exitCode = 1;
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
}

main().catch((err: unknown) => {
  // Our own refusal text is value-free; database errors can echo a value, so print only their code.
  if (err instanceof CopyRefused) console.error(err.message);
  else console.error(`copy failed: ${String((err as { code?: unknown })?.code ?? "unknown")}`);
  process.exitCode = 1;
});
