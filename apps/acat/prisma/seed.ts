// Fills the database with the demo's synthetic data (src/lib/demo/seed.ts). It empties every
// table first, so it refuses to run unless DEMO_SEED=reset is set.
//
//   DEMO_SEED=reset npx prisma db seed
import { PrismaClient } from "@prisma/client";
import { withConnectTimeout } from "../src/lib/database-url";
import { resetDemoData } from "../src/lib/demo/seed";
import { loadUniverse } from "../src/lib/demo/universe";

async function main() {
  if (process.env.DEMO_SEED !== "reset") {
    console.error("The demo seed empties every table before filling it. Set DEMO_SEED=reset to run it.");
    process.exit(1);
  }
  const prisma = new PrismaClient({ datasourceUrl: withConnectTimeout() });
  try {
    const started = Date.now();
    const summary = await resetDemoData(prisma, loadUniverse());
    console.log(JSON.stringify({ ...summary, seconds: Math.round((Date.now() - started) / 100) / 10 }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
