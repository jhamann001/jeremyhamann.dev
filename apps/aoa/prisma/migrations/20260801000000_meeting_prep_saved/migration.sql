-- AI meeting prep — "Save to client portrait" (flag AI_MEETING_PREP, owner ask
-- 2026-07-27: "make the save and export buttons work … Save saves to client
-- portrait").
--
-- The brief is ALREADY persisted by generateMeetingPrep — app.meeting_prep is
-- written the moment a human clicks Generate. Save is therefore NOT a new store;
-- it is a PROMOTION: it marks an existing Command-Center working artifact as part
-- of the client record so it renders on the Client Portrait's Meeting Prep card.
-- Hence two nullable stamp columns on the existing table rather than a second
-- table (a second table would duplicate the PII payload — the one thing ADR-7
-- spends its whole argument avoiding).
--
--   saved_at  NULL = a working artifact, visible only from the Command Center
--                    meeting row. NON-NULL = attached to the portrait.
--   saved_by  the actor email at the moment of saving (the generated_by idiom:
--             also in the audit row, kept here for the card's provenance line).
--
-- Un-saving sets both back to NULL. That is an UPDATE, which the existing
-- meeting_prep_update_write_roles policy already permits for the five non-VIEWER
-- roles — so this migration adds NO policy and NO grant. DELETE stays REVOKEd
-- with no DELETE policy (the ADR-3 posture is unchanged): un-saving detaches the
-- brief, it never destroys it.
--
-- client_sf_id already exists on this table (it is snapshotted at generation
-- time from mirror.appointment.client_sf_id) and is the join key the portrait
-- read uses. An appointment whose name never matched a mirror.client row has
-- client_sf_id NULL — there is no portrait to attach to, and the action refuses
-- with `no_client_link` rather than writing a saved row that nothing can render.

ALTER TABLE "app"."meeting_prep"
  ADD COLUMN "saved_at" TIMESTAMPTZ(6),
  ADD COLUMN "saved_by" TEXT;

-- The portrait read is exactly:
--   WHERE client_sf_id = $1 AND saved_at IS NOT NULL ORDER BY starts_at DESC
-- so index the pair. This supersedes meeting_prep_client_sf_id_idx as a prefix
-- match; that index is left in place (it is one page on a table this size and
-- dropping it is churn the owner did not ask for).
CREATE INDEX "meeting_prep_client_sf_id_saved_at_idx"
  ON "app"."meeting_prep"("client_sf_id", "saved_at");
