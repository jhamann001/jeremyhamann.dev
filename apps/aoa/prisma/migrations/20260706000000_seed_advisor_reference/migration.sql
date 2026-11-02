-- ticket — seed the firm's advisor reference data (mirror.advisor).
--
-- WHY: the Households / Client Portrait screens resolve a record's advisor to a
-- display NAME by LEFT JOINing mirror.advisor on a.email = h.lead_advisor_email
-- (lib/data/households.ts), falling back to the raw lead_advisor_email when
-- there's no match. mirror.advisor is only populated by the DEV seed
-- (prisma/seed.ts), so in PROD it is empty and those screens show the advisor's
-- EMAIL (rachel.moss@example.com) instead of "Rachel Moss". This
-- migration is the email→name map for prod. One advisor today; add rows here (or
-- via the future CRM advisor-mapping sync) as the firm grows.
--
-- The advisor of a record is a property of the RECORD (its lead_advisor_email),
-- so it renders the same for every viewer — independent of who is logged in.

-- The join keys on email, so enforce email uniqueness. Without it, a duplicate
-- advisor row for the same person (e.g. a later sync inserting Rachel under a
-- different sf_id) would fan-out the household/client joins into duplicate rows.
-- With this constraint, such a sync upserts the single row instead (ON CONFLICT
-- (email) below). mirror.advisor is empty in prod, so adding it cannot fail.
ALTER TABLE mirror.advisor
  ADD CONSTRAINT advisor_email_key UNIQUE (email);

-- Idempotent: re-running (or a later sync) updates the existing row, never
-- duplicates it. sf_id is Rachel's Salesforce contact id (stable, traceable) used
-- as the reference key until the CRM advisor/owner sync supplies a
-- canonical one; the join and RLS key is email, not sf_id.
INSERT INTO mirror.advisor (sf_id, name, email, title, active)
VALUES (
  '003Sx32720OPJ3RIAX',
  'Rachel Moss',
  'rachel.moss@example.com',
  'Advisor',
  true
)
ON CONFLICT (email) DO UPDATE
  SET name      = EXCLUDED.name,
      title     = EXCLUDED.title,
      active    = EXCLUDED.active,
      synced_at = now();
