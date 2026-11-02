import type { AssetMapRunSummary } from "@/lib/data/asset-map";
import { utcDateLabel } from "@/lib/display-date";
import { runLabel, runSwitcherMode } from "./workspace-model";
import styles from "./AssetMappingWorkspace.module.css";

function runCounts(run: AssetMapRunSummary): string {
  return `${run.totalAccounts} acct${run.totalAccounts !== 1 ? "s" : ""}, ${run.totalPositions} pos`;
}

function runDetail(run: AssetMapRunSummary): string {
  return `${utcDateLabel(run.processedAt)} · ${runCounts(run)}`;
}

export function RunSwitcher({
  runs,
  selectedId,
  onSelect,
}: {
  runs: AssetMapRunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const mode = runSwitcherMode(runs);
  if (mode === "hidden") return null;
  if (mode === "select") {
    return (
      <label className={styles.runs}>
        <span className={styles.muted}>Run</span>
        <select
          aria-label="Run"
          className={styles.editSelect}
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
        >
          {runs.map((run, idx) => (
            <option key={run.id} value={run.id}>
              {runLabel(idx, runs.length)} · {runDetail(run)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <div className={styles.runs} role="group" aria-label="Runs">
      <span className={styles.muted}>Runs:</span>
      <div className={styles.segmented}>
        {runs.map((run, idx) => (
          <button
            key={run.id}
            type="button"
            className={styles.segment}
            aria-pressed={run.id === selectedId}
            title={runCounts(run)}
            onClick={() => onSelect(run.id)}
          >
            {runLabel(idx, runs.length)} {utcDateLabel(run.processedAt)}
          </button>
        ))}
      </div>
    </div>
  );
}
