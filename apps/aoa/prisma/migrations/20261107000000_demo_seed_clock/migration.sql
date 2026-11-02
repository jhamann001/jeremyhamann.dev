-- Public demo: the clock the seed filled the database with. Every date the seed writes is relative to it, and the
-- demo's sample data (lib/demo/samples) dates itself from it too, so the samples keep the database's day between New
-- York midnight and the nightly reset, and after a reset that failed. One row, written by the seed as the owner; the
-- app login only reads it. The nightly reset empties it with everything else, and the seed writes it again.

CREATE TABLE demo.seed_clock (
  id       boolean PRIMARY KEY DEFAULT true CHECK (id),
  seed_now timestamptz NOT NULL
);

GRANT SELECT ON demo.seed_clock TO app_rw;
