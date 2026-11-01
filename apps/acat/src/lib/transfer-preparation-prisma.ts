import { PrismaClient } from "@prisma/client";
import { withConnectTimeout } from "@/lib/database-url";

// Preparation errors are reported by the HTTP boundary as opaque codes.
// The ordinary shared client's engine error logging can include query arguments
// before an application catch runs; keep that logging off for this PII-bearing
// service without changing existing browser-route behavior.
const globalPreparation = globalThis as unknown as { transferPreparationPrisma?: PrismaClient };
export const transferPreparationPrisma = globalPreparation.transferPreparationPrisma ?? new PrismaClient({ datasourceUrl: withConnectTimeout(), log: [] });
if (process.env.NODE_ENV !== "production") globalPreparation.transferPreparationPrisma = transferPreparationPrisma;
