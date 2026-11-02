import { PrismaClient } from "@prisma/client";

export const GROUP_TRANSFERS = {
  roth: "DEV-ticket-GROUP-ROTH1-20260928",
  traditional: "DEV-ticket-GROUP-TRAD-20260928",
  secondRoth: "DEV-ticket-GROUP-ROTH2-20260928",
} as const;

/** Guard before the local server or any fixture setup can touch a database. */
export function validateGroupedTasksDatabase() {
  const runtime = new URL(process.env.DATABASE_URL ?? "");
  const owner = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  for (const target of [runtime, owner]) {
    if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1"
      || target.port !== "55440" || target.pathname !== "/aoa_tkt_198_grouped_synthetic"
      || ["host", "hostaddr", "service", "servicefile"].some(key => target.searchParams.has(key))
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["prod", "dev"].includes(process.env.APP_ENV ?? "")) {
      throw new Error("Grouped Tasks browser tests require the isolated local synthetic database");
    }
  }
  if (runtime.username !== "app_rw" || owner.username !== "aoa") {
    throw new Error("Grouped Tasks browser tests require the local runtime and fixture roles");
  }
  return owner.toString();
}

export default async function setupGroupedTasksBrowser() {
  const owner = new PrismaClient({ datasourceUrl: validateGroupedTasksDatabase() });
  try {
    const rows = await owner.transfer.findMany({ where: { id: { in: Object.values(GROUP_TRANSFERS) } } });
    if (rows.length !== 3 || rows.some(row => row.household_name !== "ticket Grouped Transfer Test")) {
      throw new Error("Prepare the fixed transfer-groups synthetic fixture before running this browser suite");
    }
    // Only local synthetic auth personas. This harness never receives real sign-in credentials.
    for (const [email, name, role] of [
      ["ops@example.com", "Riley Ops", "OPERATIONS"],
      ["view@example.com", "Val Viewer", "VIEWER"],
    ] as const) {
      await owner.user.upsert({ where: { email }, create: { email, name, role }, update: { name, role } });
    }
  } finally {
    await owner.$disconnect();
  }
}
