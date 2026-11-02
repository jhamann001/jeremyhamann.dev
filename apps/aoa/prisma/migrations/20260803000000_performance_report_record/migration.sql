-- Immutable evidence for completed performance-report CALCULATIONS.
--
-- This deliberately does not claim that React/browser rendering completed, a
-- PDF was printed, or a report was delivered. It retains the exact calculated
-- numeric result and its query/rate provenance under the same opaque report id
-- printed on the output. The payload contains no client/household name and no
-- full custodian account number.

CREATE TABLE audit.performance_report_record (
  report_id           text PRIMARY KEY,
  at                  timestamptz NOT NULL DEFAULT now(),
  actor_email         text,
  actor_role          text,
  scope               text NOT NULL,
  entity_id           text NOT NULL,
  report_date         varchar(10) NOT NULL,
  as_of               varchar(10) NOT NULL,
  snapshot_version    integer NOT NULL,
  methodology_version text NOT NULL,
  source_commit_sha   text NOT NULL,
  payload_sha256      char(64) NOT NULL,
  payload             jsonb NOT NULL,
  CONSTRAINT performance_report_record_scope_chk
    CHECK (scope IN ('account', 'household')),
  CONSTRAINT performance_report_record_snapshot_version_chk
    CHECK (snapshot_version = 1),
  CONSTRAINT performance_report_record_report_date_chk
    CHECK (report_date ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT performance_report_record_as_of_chk
    CHECK (as_of ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT performance_report_record_payload_sha_chk
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX performance_report_record_at_idx
  ON audit.performance_report_record (at);
CREATE INDEX performance_report_record_scope_entity_at_idx
  ON audit.performance_report_record (scope, entity_id, at);

REVOKE ALL ON audit.performance_report_record FROM PUBLIC;
GRANT INSERT, SELECT ON audit.performance_report_record TO app_rw;

-- INSERT is allowed only inside the same scoped human transaction used by the
-- report route, and the stored actor must match that transaction's GUCs.
ALTER TABLE audit.performance_report_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.performance_report_record FORCE ROW LEVEL SECURITY;

CREATE POLICY performance_report_record_insert ON audit.performance_report_record
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE')
    AND actor_role = current_setting('app.user_role', true)
    AND actor_email IS NOT DISTINCT FROM
      NULLIF(current_setting('app.user_email', true), '')
  );

-- Numeric client-report evidence is more sensitive than the counts-only event
-- trail. Privileged roles may retrieve the archive; other report roles may see
-- only rows they created. The latter is also required for PostgreSQL to permit
-- INSERT ... RETURNING (used by Prisma) without weakening cross-user access.
CREATE POLICY performance_report_record_privileged_read
  ON audit.performance_report_record
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
    OR (
      actor_role = current_setting('app.user_role', true)
      AND actor_email IS NOT DISTINCT FROM
        NULLIF(current_setting('app.user_email', true), '')
    )
  );

-- Immutability is enforced by absence: app_rw receives no UPDATE or DELETE.
