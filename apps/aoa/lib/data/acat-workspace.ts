import "server-only";
import { createSnapshotCache } from "./snapshot-cache";
import { ACAT_WORKSPACE_TTL, type AcatWorkspaceView, type AcatWorkspaceSnapshot } from "./acat-workspace-contract";
import { canReadCustodianLibrary, type CustodianLibrary } from "./custodian-library-contract";
import { getCustodianLibrary } from "./custodian-library";
import { canSeeUnlinkedAcats } from "./acat-lane";
import { fetchAcatOpsBook, fetchAcatOpsList, type AcatListRow } from "./acat-status";
import { ACAT_BOOK_LIST_QUERY, type AcatBookRow } from "./acat-book";
import { buildAcatTracking } from "./acat-tracking";
import { listTransfers } from "./transfers";
import type { Identity } from "./types";

const libraryCache = createSnapshotCache<CustodianLibrary>(ACAT_WORKSPACE_TTL.library);
const trackingCache = createSnapshotCache<AcatListRow[]>(ACAT_WORKSPACE_TTL.tracking);
const bookCache = createSnapshotCache<AcatBookRow[]>(ACAT_WORKSPACE_TTL.tracking);
const removedCache = createSnapshotCache<AcatBookRow[]>(ACAT_WORKSPACE_TTL.tracking);
let bookStale = false;
let libraryStale = false;

/** The next readAcatBook skips this process's cached book once. */
export function markAcatBookStale(): void {
  bookStale = true;
}

/** The next library read skips this process's cached library once. */
export function markCustodianLibraryStale(): void {
  libraryStale = true;
}

export type AcatBookSnapshot = {
  rows: AcatBookRow[];
  linkedTransferIds: Record<string, string>;
  linkedByRecordId: Record<string, string>;
  removedRows: AcatBookRow[] | null;
};

async function readSource<T>(load: (options: { signal: AbortSignal }) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8_000);
  try { return await load({ signal: controller.signal }); }
  finally { clearTimeout(deadline); }
}

/** The full book for the flag-on tracking view. Same role gate and linkage
 *  source as readAcatWorkspace; only the firm-wide book rows are cached. */
export async function readAcatBook(identity: Identity, options: { removed?: boolean } = {}): Promise<AcatBookSnapshot> {
  const role = identity.role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) {
    throw new Error("ACAT workspace forbidden");
  }
  const source = JSON.stringify([process.env.APP_ENV, process.env.TRANSFER_TRACKER_URL, process.env.ACAT_FIXTURE, ACAT_BOOK_LIST_QUERY]);
  const refresh = bookStale;
  bookStale = false;
  const [transfers, snapshot, removed] = await Promise.all([
    listTransfers(identity, { includeArchived: true }),
    bookCache.read(source, () => readSource(fetchAcatOpsBook), refresh),
    options.removed
      ? removedCache.read(source, () => readSource((o) => fetchAcatOpsBook({ ...o, removed: true })), refresh)
      : Promise.resolve(null),
  ]);
  const linkedTransferIds: Record<string, string> = {};
  const linkedByRecordId: Record<string, string> = {};
  for (const t of transfers) {
    if (t.acat_transfer_id) linkedTransferIds[t.acat_transfer_id] = t.id;
    if (t.acat_record_id) linkedByRecordId[t.acat_record_id] = t.id;
  }
  return { rows: snapshot.data, linkedTransferIds, linkedByRecordId, removedRows: removed ? removed.data : null };
}

/** Used ONLY by the authenticated workspace page and read endpoint. Detail
 * reads elsewhere stay live. Only the firm-wide source projection is shared;
 * identity-scoped database linkage is never cached across users/requests. */
export async function readAcatWorkspace(identity: Identity, view: AcatWorkspaceView, refresh = false): Promise<AcatWorkspaceSnapshot> {
  const role = identity.role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) {
    throw new Error("ACAT workspace forbidden");
  }
  const source = JSON.stringify([process.env.APP_ENV, process.env.TRANSFER_TRACKER_URL, process.env.ACAT_FIXTURE]);
  if (view === "library") {
    const refreshLibrary = refresh || libraryStale;
    libraryStale = false;
    return { view, ...await libraryCache.read(source, () => getCustodianLibrary(role), refreshLibrary) };
  }
  const [transfers, snapshot] = await Promise.all([
    listTransfers(identity, { includeArchived: true }),
    trackingCache.read(source, async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 8_000);
      try { return await fetchAcatOpsList({ signal: controller.signal }); }
      finally { clearTimeout(deadline); }
    }, refresh),
  ]);
  const linked = new Map<string, string>();
  const byRecord = new Map<string, string>();
  for (const t of transfers) {
    if (t.acat_transfer_id) linked.set(t.acat_transfer_id, t.id);
    if (t.acat_record_id) byRecord.set(t.acat_record_id, t.id);
  }
  return { view, checkedAt: snapshot.checkedAt, expiresAt: snapshot.expiresAt,
    data: buildAcatTracking(snapshot.data, linked, byRecord) };
}
