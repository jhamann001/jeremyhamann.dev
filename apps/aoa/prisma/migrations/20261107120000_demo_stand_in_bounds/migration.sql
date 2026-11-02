-- Public demo: a ceiling on the stand-ins' records. Visitors add records (tracker transfers, pipeline destinations)
-- and make them bigger (history, assets), and nothing removes one before the nightly reset. The app stops each kind at
-- 1,000 new records (lib/demo/stand-ins/store.ts); this is the database's own stop, whatever writes: at most 4,000
-- records and 16 MB of stored JSON in all. The seed writes about 1,100 records and 1 MB. A row trigger on INSERT and
-- UPDATE only: the nightly reset empties the table with TRUNCATE, which it doesn't see.

CREATE FUNCTION demo.stand_in_record_bounds() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  max_rows   constant bigint := 4000;
  max_bytes  constant bigint := 16 * 1024 * 1024;
  others     bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- One adder at a time, so two visitors can't both take the last place.
    PERFORM pg_advisory_xact_lock(hashtext('demo.stand_in_record_bounds'));
    IF NOT EXISTS (SELECT 1 FROM demo.stand_in_record r
                    WHERE r.service = NEW.service AND r.kind = NEW.kind AND r.id = NEW.id)
       AND (SELECT count(*) FROM demo.stand_in_record) >= max_rows THEN
      RAISE EXCEPTION 'the demo keeps at most % stand-in records', max_rows USING ERRCODE = 'program_limit_exceeded';
    END IF;
    SELECT COALESCE(sum(pg_column_size(r.doc)), 0) INTO others FROM demo.stand_in_record r
     WHERE (r.service, r.kind, r.id) <> (NEW.service, NEW.kind, NEW.id);
  ELSE
    SELECT COALESCE(sum(pg_column_size(r.doc)), 0) INTO others FROM demo.stand_in_record r
     WHERE (r.service, r.kind, r.id) <> (OLD.service, OLD.kind, OLD.id);
  END IF;
  IF others + pg_column_size(NEW.doc) > max_bytes THEN
    RAISE EXCEPTION 'the demo keeps at most % bytes of stand-in records', max_bytes USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER stand_in_record_bounds
  BEFORE INSERT OR UPDATE ON demo.stand_in_record
  FOR EACH ROW EXECUTE FUNCTION demo.stand_in_record_bounds();
