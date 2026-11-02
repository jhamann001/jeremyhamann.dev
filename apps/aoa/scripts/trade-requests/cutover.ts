import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { singleConnectionUrl } from "../../lib/trade-requests/cutover-connection";
import { createCutoverController, type CommandResult, type SenderKind } from "../../lib/trade-requests/cutover-controller";
import { engineUseExemption, ExemptionMisuse } from "../../lib/trade-requests/cutover-gates";
import { createStandaloneControl, googleTransport } from "../../lib/trade-requests/standalone-control";

// Operator command for the Trade Request cutover and rollback (ticket). Prints one JSON line per gate and step
// and a summary; never a row value, URL or token. Exit 0 when the command completed, 1 when refused or abandoned,
// 2 on a usage or configuration error.

const USAGE =
  "usage: tsx scripts/trade-requests/cutover.ts preflight|cutover|retire|rollback|recover|handoff --kind=digest|drift --to=aoa|standalone";

export type ParsedArgs =
  | { command: "preflight" | "cutover" | "retire" | "rollback" | "recover" }
  | { command: "handoff"; kind: SenderKind; to: "aoa" | "standalone" };

export function parseCutoverArgs(argv: string[]): ParsedArgs | null {
  const [command, ...rest] = argv;
  if (command === "preflight" || command === "cutover" || command === "retire" || command === "rollback" || command === "recover") {
    return rest.length === 0 ? { command } : null;
  }
  if (command !== "handoff" || rest.length !== 2) return null;
  const kind = rest.find((a) => a.startsWith("--kind="))?.slice("--kind=".length);
  const to = rest.find((a) => a.startsWith("--to="))?.slice("--to=".length);
  if ((kind !== "digest" && kind !== "drift") || (to !== "aoa" && to !== "standalone")) return null;
  return { command, kind, to };
}

export async function cutoverMain(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const args = parseCutoverArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  let exemption: string | null;
  try {
    exemption = engineUseExemption(env.APP_ENV, env.TRADE_REQUEST_CUTOVER_ENGINE_USE_EXEMPTION, env.CLOUD_RUN_JOB, env.TRADE_REQUEST_API_URL);
  } catch (err) {
    if (!(err instanceof ExemptionMisuse)) throw err;
    console.error(err.message);
    return 2;
  }
  const needsSource = args.command === "cutover" || args.command === "rollback";
  if (!env.DIRECT_DATABASE_URL || !env.TRADE_REQUEST_API_URL || (needsSource && !env.TRADE_REQUEST_SOURCE_DATABASE_URL)) {
    console.error(
      `DIRECT_DATABASE_URL and TRADE_REQUEST_API_URL are required${needsSource ? ", and TRADE_REQUEST_SOURCE_DATABASE_URL for this command" : ""}`,
    );
    return 2;
  }
  const aoaUrl = singleConnectionUrl(env.DIRECT_DATABASE_URL);
  const sourceUrl = needsSource ? singleConnectionUrl(env.TRADE_REQUEST_SOURCE_DATABASE_URL!) : null;
  const aoa = new PrismaClient({ datasourceUrl: aoaUrl });
  const source = sourceUrl ? new PrismaClient({ datasourceUrl: sourceUrl }) : null;
  // While a copy runs the job holds two AOA connections (controller and copy) and two on the standalone database.
  const openCopyClients = sourceUrl
    ? async () => {
        const target = new PrismaClient({ datasourceUrl: aoaUrl });
        const copySource = new PrismaClient({ datasourceUrl: sourceUrl });
        return {
          target,
          source: copySource,
          close: async () => {
            await target.$disconnect();
            await copySource.$disconnect();
          },
        };
      }
    : null;
  const actor = env.CLOUD_RUN_EXECUTION ? `job:${env.CLOUD_RUN_EXECUTION}` : `local:${env.USER ?? "operator"}`;
  const controller = createCutoverController({
    aoa,
    source,
    openCopyClients,
    standalone: createStandaloneControl(googleTransport(env.TRADE_REQUEST_API_URL)),
    actor,
    exemption,
    // Single-line JSON for Cloud Logging (lib/observability/structured-log.ts convention): labels and counts only.
    log: (event) =>
      console.log(JSON.stringify({ severity: event.status === "refused" ? "WARNING" : "INFO", component: "trade-request-cutover", ...event })),
  });
  try {
    let result: CommandResult;
    if (args.command === "handoff") result = await controller.handoff(args.kind, args.to);
    else result = await controller[args.command]();
    console.log(
      JSON.stringify({ event: "cutover_summary", command: result.command, outcome: result.outcome, gates: result.gates.length, steps: result.steps.length }),
    );
    return result.outcome === "done" ? 0 : 1;
  } finally {
    await aoa.$disconnect();
    await source?.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cutoverMain(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // Database errors can echo a value: print only a code.
      console.error(`cutover failed: ${String((err as { code?: unknown })?.code ?? "unknown")}`);
      process.exitCode = 1;
    },
  );
}
