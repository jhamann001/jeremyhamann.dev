-- Additive ticket source envelope. No Bcc column, body rewrite, grant or RLS change.
ALTER TABLE mirror.email ADD COLUMN email_envelope jsonb;
ALTER TABLE mirror.email ADD CONSTRAINT email_envelope_shape CHECK (
  email_envelope IS NULL OR (
    jsonb_typeof(email_envelope) = 'object'
    AND email_envelope ?& ARRAY['version','state','task_sf_id','message_sf_id','observed_at','source_modified_at','sender','to','cc']::text[]
    AND email_envelope - ARRAY['version','state','task_sf_id','message_sf_id','observed_at','source_modified_at','sender','to','cc']::text[] = '{}'::jsonb
    AND email_envelope->>'version' = '1'
    AND email_envelope->>'state' IN ('MATCHED','MISSING','UNAVAILABLE','AMBIGUOUS')
    AND jsonb_typeof(email_envelope->'to') = 'array'
    AND jsonb_typeof(email_envelope->'cc') = 'array'
    AND NOT jsonb_path_exists(email_envelope, '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "bcc" flag "i")')
  )
);

-- Non-unique: retain and explicitly report historical 15/18-character aliases.
CREATE INDEX email_task_source_key_idx ON mirror.email ((left(sf_id, 15)));
