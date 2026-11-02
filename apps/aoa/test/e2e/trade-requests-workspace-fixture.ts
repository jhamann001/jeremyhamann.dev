import { PrismaClient } from "@prisma/client";

const DATABASE_NAME = "aoa_trw04_synthetic";
export const CLIENT_SERVICE_EMAIL = "client-service.synthetic@example.com";

function localUrl(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_browser_database_url_required");
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
  ) throw new Error("trade_requests_browser_requires_isolated_loopback_database");
  return url;
}

/** Called by the config before any server starts, then again by setup. */
export function validateTradeRequestsBrowserDatabase(): URL {
  const owner = localUrl(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = localUrl(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_browser_database_target_mismatch");
  return owner;
}

/** Adds the one synthetic CLIENT_SERVICE user the seed lacks; removes it afterwards. */
export default async function tradeRequestsWorkspaceFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateTradeRequestsBrowserDatabase().toString(), log: [] });
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== DATABASE_NAME) throw new Error("trade_requests_browser_actual_database_mismatch");
    await owner.user.upsert({
      where: { email: CLIENT_SERVICE_EMAIL },
      create: { email: CLIENT_SERVICE_EMAIL, name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
      update: { name: "Casey Service (synthetic)", role: "CLIENT_SERVICE" },
    });
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
