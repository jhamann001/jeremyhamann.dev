-- Public demo: the outside services' records. In the demo the Transfer Tracker, the statement pipeline and the
-- warehouse are answered inside the app (lib/demo/stand-ins); each row here is one of that service's records, kept
-- as the JSON its API returns. The app login may read, add and change rows, never remove them (a removal is a flag
-- on the record, as in the services themselves); the nightly reset restores the seed. Outside the demo nothing reads
-- or writes it.

CREATE TABLE demo.stand_in_record (
  service    text NOT NULL CHECK (service IN ('tracker', 'pipeline', 'warehouse')),
  kind       text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  id         text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  doc        jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND pg_column_size(doc) <= 262144),
  position   integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, kind, id)
);

CREATE INDEX stand_in_record_list_idx ON demo.stand_in_record (service, kind, position, id);

GRANT SELECT, INSERT, UPDATE ON demo.stand_in_record TO app_rw;
