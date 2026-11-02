import { PrismaClient } from "@prisma/client";

export const TRW11_DATABASE = "aoa_trw11_synthetic";
export const CLIENT_SERVICE_EMAIL = "client-service.synthetic@example.com";

function loopback(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("trade_requests_new_browser_database_url_required");
  const url = new URL(raw);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port
    || url.pathname !== `/${TRW11_DATABASE}`
    || url.username !== user
    || ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || process.env.APP_ENV === "prod"
  ) throw new Error("trade_requests_new_browser_requires_isolated_loopback_database");
  return url;
}

export function validateNewRequestBrowserDatabase(): URL {
  const owner = loopback(process.env.DIRECT_DATABASE_URL, "aoa");
  const runtime = loopback(process.env.DATABASE_URL, "app_rw");
  if (owner.host !== runtime.host) throw new Error("trade_requests_new_browser_database_target_mismatch");
  return owner;
}

/** Adds the synthetic CLIENT_SERVICE user the seed lacks; removes it afterwards. */
export default async function tradeRequestsNewFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateNewRequestBrowserDatabase().toString(), log: [] });
  try {
    const [{ database }] = await owner.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database !== TRW11_DATABASE) throw new Error("trade_requests_new_browser_actual_database_mismatch");
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
