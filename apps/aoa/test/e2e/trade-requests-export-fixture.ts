import { PrismaClient } from "@prisma/client";
import { CLIENT_SERVICE_EMAIL } from "./trade-requests-workspace-fixture";
import { seedTradeRequestsExport } from "./trade-requests-export-seed";

const DATABASE_NAME = "aoa_trw10_synthetic";

function localUrl(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_export_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port
    || url.pathname !== `/${DATABASE_NAME}`
    || url.username !== user
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
  ) throw new Error("trade_requests_export_requires_isolated_loopback_database");
  return url;
}

/** Called by the config before any server starts, then again by setup. */
export function validateTradeRequestsExportDatabase(): URL {
  const owner = localUrl(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = localUrl(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_export_database_target_mismatch");
  return owner;
}

/** Adds the synthetic CLIENT_SERVICE user and seeds the local service through its delegated API. */
export default async function tradeRequestsExportFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateTradeRequestsExportDatabase().toString(), log: [] });
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== DATABASE_NAME) throw new Error("trade_requests_export_actual_database_mismatch");
    await owner.user.upsert({
      where: { email: CLIENT_SERVICE_EMAIL },
      create: { email: CLIENT_SERVICE_EMAIL, name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
      update: { name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
    });
    await seedTradeRequestsExport();
  } catch (error) {
    await owner.$disconnect();
    throw error;
  }
  return async () => {
    try {
      await owner.user.deleteMany({ where: { email: CLIENT_SERVICE_EMAIL } });
    } finally {
      await owner.$disconnect();
    }
  };
}
