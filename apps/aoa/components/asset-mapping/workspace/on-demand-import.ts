export type ImportThenReloadDeps = {
  runImport: () => Promise<{ ok: boolean }>;
  reload: () => Promise<void>;
};

/** Runs the on-demand import, then reloads. A failed import reloads nothing, so the current data stays (ticket). */
export async function importThenReload(deps: ImportThenReloadDeps): Promise<boolean> {
  let ok = false;
  try {
    ok = (await deps.runImport()).ok;
  } catch {
    ok = false;
  }
  if (ok) await deps.reload().catch(() => undefined);
  return ok;
}
