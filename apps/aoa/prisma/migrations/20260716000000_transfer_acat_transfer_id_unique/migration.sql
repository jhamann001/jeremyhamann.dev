-- ticket follow-up (QC MEDIUM-1): enforce the 1:1 ACAT <-> transfer invariant
-- at the DATABASE as the true backstop for the application-layer duplicate guard.
--
-- The app guard (lib/data/acat-link.ts: findFirst-then-create/update) has a
-- TOCTOU window: two concurrent link/attach requests for the same ACAT can both
-- pass the read, then both write. This PARTIAL UNIQUE INDEX closes that window —
-- the second writer loses with a unique-violation (Prisma P2002), which the
-- actions map to the friendly "already linked" message.
--
-- PARTIAL (WHERE acat_transfer_id IS NOT NULL): the vast majority of transfers
-- legitimately carry a NULL acat_transfer_id (no ACAT yet) and must remain
-- unconstrained. Prisma's schema DSL cannot express a filtered/partial unique
-- index (no WHERE on @@unique), so this is a hand-authored raw SQL migration and
-- schema.prisma intentionally does NOT declare an @@unique for this column (a
-- plain @@unique would generate a non-partial index — functionally similar under
-- Postgres NULL semantics, but we keep the explicit partial form the QC asked
-- for). NOTE: `prisma migrate dev` will report this index as drift; the repo
-- deploys via `prisma migrate deploy`, which does not diff — do not "fix" the
-- drift by dropping the index.

-- (a) De-duplicate FIRST so CREATE UNIQUE INDEX cannot fail on pre-existing data.
--     For any acat_transfer_id shared by more than one row, keep the EARLIEST by
--     created_at (id as the deterministic tie-break) and NULL out acat_transfer_id
--     on the rest. This un-links the accidental duplicates rather than deleting
--     any transfer; the surviving row keeps the ACAT link.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY acat_transfer_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM "app"."transfer"
  WHERE acat_transfer_id IS NOT NULL
)
UPDATE "app"."transfer" AS t
SET acat_transfer_id = NULL
FROM ranked
WHERE t.id = ranked.id
  AND ranked.rn > 1;

-- (b) The partial unique index — the enforced 1:1 backstop.
CREATE UNIQUE INDEX "transfer_acat_transfer_id_key"
  ON "app"."transfer" ("acat_transfer_id")
  WHERE "acat_transfer_id" IS NOT NULL;
