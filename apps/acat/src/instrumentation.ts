// Runs once when the server starts. In the demo (DEMO_STAND_INS=on) it starts the loopback stand-ins
// for the outside services; see src/lib/demo/stand-ins/server.ts.

const STARTED = Symbol.for("transfer-tracker.standInsStarted");

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DEMO_STAND_INS !== "on") return;
  const store = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (store[STARTED]) return;
  store[STARTED] = true;
  const [{ startStandIns }, { prismaStandInDeps }, { prisma }, { standInsPort }] = await Promise.all([
    import("./lib/demo/stand-ins/server"),
    import("./lib/demo/stand-ins/prisma-deps"),
    import("./lib/prisma"),
    import("./lib/demo/flags"),
  ]);
  await startStandIns(prismaStandInDeps(prisma));
  console.log(`[stand-ins] listening on 127.0.0.1:${standInsPort()}`);
}
