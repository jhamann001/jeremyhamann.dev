-- Up Migration
--
-- Extend `position_drift_accounts.status` to allow two new non-actionable
-- data-quality lanes (drift-checker tuning rules R1 and R2):
--
--   * `negligible`       — total account value <= $5 (incl. residual dust).
--                          Drift is meaningless at this size; never flag.
--   * `template_invalid` — the Meridian template weights do not sum to
--                          ~100% (outside a 99–101% band), so the drift
--                          denominator is wrong. We still persist the
--                          computed delta (so the magnitude is inspectable)
--                          but tag it so it is excluded from the actionable
--                          out-of-tolerance count and routed to a "fix
--                          template" data-quality view.
--
-- `out` remains the ONLY actionable status, so every existing consumer that
-- keys on `status = 'out'` (the exclusion-overlap analysis, the Slack alert
-- counts, the dashboard's worst-Δ) automatically excludes these new lanes.
--
-- Backward-compatible: every row that satisfied the old CHECK still
-- satisfies the new one.

ALTER TABLE position_drift_accounts
    DROP CONSTRAINT position_drift_accounts_status_check;

ALTER TABLE position_drift_accounts
    ADD CONSTRAINT position_drift_accounts_status_check
    CHECK (status IN ('in', 'out', 'uninvested', 'no_template', 'negligible', 'template_invalid'));

-- Down Migration
--
-- Reverting requires down-converting any rows carrying the new statuses
-- first, because the old CHECK would reject them. Map them to the closest
-- legacy meaning: `negligible` -> `uninvested` (cash-heavy / not actionable),
-- `template_invalid` -> `out` (it carried a real, if untrustworthy, delta).

UPDATE position_drift_accounts SET status = 'uninvested' WHERE status = 'negligible';
UPDATE position_drift_accounts SET status = 'out' WHERE status = 'template_invalid';

ALTER TABLE position_drift_accounts
    DROP CONSTRAINT position_drift_accounts_status_check;

ALTER TABLE position_drift_accounts
    ADD CONSTRAINT position_drift_accounts_status_check
    CHECK (status IN ('in', 'out', 'uninvested', 'no_template'));
