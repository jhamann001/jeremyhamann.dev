-- Always-On Advice — asset-mapping person link, Phase 2 slice P2.3
-- (ops confirm/reject write-back on mirror.acat_asset_map_link).
--
-- P2.0 (20260719000000) created the link store as ingest_rw-WRITE / app_rw-READ:
-- the machine (reconcile pass P2.2, via withIngestScope/ingest_rw) creates and
-- scores rows; the app (ops review queue, via withUserScope/app_rw) only READS
-- them. P2.3 adds the ONE human write the design calls for — an ops CONFIRM or
-- REJECT of a NEEDS_REVIEW row — and it must land on THIS table.
--
-- ARCHITECTURE DECISION (flagged for owner review — see the PR body):
--   The link table becomes a deliberate HYBRID:
--     • machine matches      → ingest_rw INSERT/UPDATE (unchanged, P2.0)
--     • human confirmations  → app_rw UPDATE (this migration)
--   This is an INTENTIONAL EXCEPTION to the mirror "app_rw is read-only"
--   convention. It is the cleaner of the two models: an ops confirmation is an
--   app-owned write by a human actor, so it runs under the human's own RLS scope
--   (withUserScope / app_rw) and audits with the human's identity — NOT by
--   borrowing the machine's GUC-less ingest role from a user-facing action (the
--   REJECTED ALTERNATIVE, which would launder a human write through the machine
--   identity and defeat the audit trail).
--
-- SCOPE OF THE GRANT — deliberately minimal:
--   • GRANT UPDATE only. NOT INSERT: creating/queuing a link row stays an
--     ingest-only responsibility (the reconcile pass), so the human path can
--     only ACT ON an already-queued row, never mint one. This is why the P2.3
--     write is a plain UPDATE (lib/data/asset-map-link.updateLinkDecision),
--     NOT the P2.0 setLink INSERT ... ON CONFLICT (which would require INSERT).
--   • NO DELETE for anyone, ever (ADR-7): a reversed decision is expressed via
--     match_status, never a row delete — one folder's link history is preserved.
--   • No new columns: P2.0 already carries client_sf_id / cedar_ridge_user_id /
--     household_sf_id / match_status / confidence / confirmed_by / confirmed_at.
--
-- The FOR UPDATE policy predicate is IDENTICAL to the existing ops-read policy
-- acat_asset_map_link_ops_all (ADMIN / OPERATIONS / HEAD_OF_ADVISORY via the
-- app.user_role GUC) — the same firm-wide ops surface reads and confirms. A
-- missing GUC → NULL → fails closed, so advisors / client-service / VIEWER (no
-- matching policy) can neither read nor write the queue. Additive-only (ADR-5):
-- one grant + one policy, nothing altered/dropped.

-- ---------------------------------------------------------------------------
-- 1. Grant — app_rw may now UPDATE (only) the link table. ingest_rw's existing
--    SELECT/INSERT/UPDATE and app_rw's existing SELECT are untouched.
-- ---------------------------------------------------------------------------
GRANT UPDATE ON mirror.acat_asset_map_link TO app_rw;

-- ---------------------------------------------------------------------------
-- 2. RLS — the ops UPDATE write policy. USING gates which existing rows an ops
--    user may target; WITH CHECK gates the post-update row. Both use the same
--    role-GUC predicate as acat_asset_map_link_ops_all, so a non-ops role
--    matches no policy and the UPDATE affects zero rows (fails closed — the
--    action reads the 0 rowcount as a rejection). FORCE RLS is already ON from
--    P2.0; this only adds the policy.
-- ---------------------------------------------------------------------------
CREATE POLICY acat_asset_map_link_ops_update ON mirror.acat_asset_map_link
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );
