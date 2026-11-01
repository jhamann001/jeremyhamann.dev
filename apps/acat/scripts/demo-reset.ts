// Resets the demo from the command line, as the nightly reset does (src/lib/demo/reset.ts). The deploy
// runs it after migrating, so each deploy starts on fresh data. It starts the stand-ins on loopback for
// the directory sync and the daily digest, with keys of its own, and stops them when it is done.
//
//   DEMO_SEED=reset npm run demo:reset
//
// Needs DATABASE_URL and the demo's settings (demo-config.json), as the container has them.
import { randomBytes } from "node:crypto";

const fresh = () => randomBytes(32).toString("hex");

async function main() {
  if (process.env.DEMO_SEED !== "reset") {
    console.error("The demo reset empties every table before filling it. Set DEMO_SEED=reset to run it.");
    process.exit(1);
  }
  if (process.env.DEMO_STAND_INS !== "on") {
    console.error("Load the demo settings first (demo-config.json): the reset needs DEMO_STAND_INS=on.");
    process.exit(1);
  }
  // The stand-ins check the same keys the app's clients send, so both read them from here.
  const port = Number(process.env.STAND_INS_PORT ?? 8090);
  process.env.FEE_STORE_API_KEY = fresh();
  process.env.CLIENT_DIRECTORY_WAREHOUSE_API_KEY = fresh();
  process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${port}/slack/services/T0DEMO/B0DEMO/${fresh()}`;

  const [{ startStandIns }, { prismaStandInDeps }, { prisma }, { runDemoReset }] = await Promise.all([
    import("../src/lib/demo/stand-ins/server"),
    import("../src/lib/demo/stand-ins/prisma-deps"),
    import("../src/lib/prisma"),
    import("../src/lib/demo/reset"),
  ]);
  const server = await startStandIns(prismaStandInDeps(prisma), port);
  try {
    const started = Date.now();
    const result = await runDemoReset();
    console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 100) / 10 }, null, 2));
    if (result.directory !== "published" || !result.digestSent) {
      console.error("The data was reset, but the directory sync or the digest failed (see above).");
      process.exitCode = 1;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
