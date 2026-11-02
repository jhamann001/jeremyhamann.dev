import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { withUserScope } from "@/lib/rls";
import { readCustodianAuthorityProfiles } from "./custodian-authority";
import { canReadCustodianLibrary, custodianLibrarySchema, custodianProfileSchema } from "./custodian-library-contract";
import { readObservedCustodianTiming } from "./custodian-timing";

const auth = new ServiceAuth();
const DEFAULT_URL = "https://transfers.jeremyhamann.dev";

export class CustodianLibraryError extends Error {
  constructor(readonly reason: "forbidden" | "unavailable" | "invalid_response") {
    super("Custodian library unavailable");
    this.name = "CustodianLibraryError";
  }
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CustodianLibraryError("unavailable"));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function trackerOrigin(): string {
  const base = new URL(process.env.TRANSFER_TRACKER_URL ?? DEFAULT_URL);
  if (base.protocol !== "https:" || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Invalid tracker origin");
  }
  return base.origin;
}

/** The tracker origin and an ID-token client for it, for the admin writer.
 * Credential discovery stops being awaited when `signal` aborts. */
export async function custodianTrackerClient(signal: AbortSignal) {
  const origin = trackerOrigin();
  const client = await untilAborted(auth.getIdTokenClient(origin), signal);
  return { client, origin };
}

async function getAuthorityCustodianLibrary(role: string) {
  const read = await readCustodianAuthorityProfiles(role);
  if (!read.ok) throw new CustodianLibraryError("unavailable");

  const plain = read.value.map((record) => ({
    id: record.id,
    name: record.name,
    reviewStatus: record.reviewStatus,
    acatFeeAmount: record.acatFeeAmount,
    transferType: record.transferType,
    documentationStatus: record.documentationStatus,
    dtcNumber: record.dtcNumber,
    receivingAccountNumber: record.receivingAccountNumber,
    signature: record.signature,
    letterOfAcceptance: record.letterOfAcceptance,
    medallionRequired: record.medallionRequired,
    liquidationMethod: record.liquidationMethod,
    returnMethod: record.returnMethod,
    watchouts: record.watchouts,
    paperworkOnFile: record.paperworkOnFile,
    transfersToDate: record.transfersToDate,
    contactEmail: record.contactEmail,
    contactMethod: record.contactMethod as "EMAIL" | "PHONE" | "PORTAL" | "OTHER" | null,
    contactDetails: record.contactDetails,
    configuredExpectedProcessingDays: record.avgProcessingDays,
    observedAvgProcessingBusinessDays: null as number | null,
    observedCompletedTransfers: 0,
    observedTimingAvailable: true as boolean,
    fees: record.fees.map((fee) => ({
      id: fee.id,
      feeType: fee.feeType,
      accountType: fee.accountType,
      transferType: fee.transferType,
      direction: fee.direction,
      amount: fee.amount,
      amountText: fee.amountText,
      notes: fee.notes,
      documentation: fee.documentation,
      createdAt: fee.createdAt,
      updatedAt: fee.updatedAt,
    })),
    feeSchedules: [] as Array<{
      id: string;
      filename: string;
      contentType: "application/pdf" | "image/png" | "image/jpeg";
      byteSize: number;
      sha256: string;
      createdAt: string;
    }>,
  }));

  try {
    const timing = await readObservedCustodianTiming();
    for (const profile of plain) {
      const sample = timing.get(profile.id);
      profile.observedTimingAvailable = true;
      profile.observedAvgProcessingBusinessDays = sample?.observedAvgProcessingBusinessDays ?? null;
      profile.observedCompletedTransfers = sample?.observedCompletedTransfers ?? 0;
    }
  } catch {
    for (const profile of plain) {
      profile.observedTimingAvailable = false;
      profile.observedAvgProcessingBusinessDays = null;
      profile.observedCompletedTransfers = 0;
    }
  }

  const documents = await withUserScope({ role, email: null }, async (tx) =>
    tx.custodianFeeScheduleDocument.findMany({
      select: {
        id: true,
        custodianId: true,
        filename: true,
        contentType: true,
        byteSize: true,
        sha256: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  );
  const byCustodian = new Map<string, typeof documents>();
  for (const doc of documents) {
    const list = byCustodian.get(doc.custodianId) ?? [];
    list.push(doc);
    byCustodian.set(doc.custodianId, list);
  }
  for (const profile of plain) {
    const rows = byCustodian.get(profile.id) ?? [];
    profile.feeSchedules = rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType as "application/pdf" | "image/png" | "image/jpeg",
      byteSize: row.byteSize,
      sha256: row.sha256,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    }));
  }

  const custodians = plain.map((profile) => {
    const parsed = custodianProfileSchema.safeParse(profile);
    if (!parsed.success) throw new CustodianLibraryError("invalid_response");
    return parsed.data;
  });
  return {
    schemaVersion: 1 as const,
    retrievedAt: new Date().toISOString(),
    custodians,
  };
}

/** Server-only, live GET. No cross-request cache, token logging or MCP user
 * credentials. The page authenticates first; this role gate is defense in depth. */
export async function getCustodianLibrary(role: string) {
  if (!canReadCustodianLibrary(role)) throw new CustodianLibraryError("forbidden");
  return getAuthorityCustodianLibrary(role);
}
