BEGIN;

ALTER TABLE app.operations_fee_request
  ADD COLUMN submission_key varchar(36),
  ADD COLUMN submission_digest char(64),
  ADD CONSTRAINT operations_fee_request_submission_shape CHECK (
    (submission_key IS NULL AND submission_digest IS NULL) OR
    (submission_key IS NOT NULL AND submission_digest IS NOT NULL
      AND submission_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND submission_digest ~ '^[0-9a-f]{64}$'
      AND submitted_by_email IS NOT NULL AND legacy_source IS NULL)
  ),
  ADD CONSTRAINT operations_fee_request_submission_key UNIQUE (submitted_by_email, submission_key);

CREATE FUNCTION app.protect_operations_fee_submission_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.submission_key IS DISTINCT FROM OLD.submission_key
    OR NEW.submission_digest IS DISTINCT FROM OLD.submission_digest THEN
    RAISE EXCEPTION 'operations_submission_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_operations_fee_submission_identity() FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
CREATE TRIGGER operations_fee_submission_identity_immutable
  BEFORE UPDATE ON app.operations_fee_request FOR EACH ROW
  EXECUTE FUNCTION app.protect_operations_fee_submission_identity();

CREATE TABLE app.operations_slack_notification (
  request_id text PRIMARY KEY REFERENCES app.operations_fee_request(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_id bigint NOT NULL UNIQUE REFERENCES app.operations_fee_request_event(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  channel_id varchar(32) NOT NULL DEFAULT 'C00OBJK6X0W' CHECK (channel_id = 'C00OBJK6X0W'),
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'RETRY', 'SENT', 'FAILED', 'UNCERTAIN')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  last_code varchar(64) CHECK (last_code IS NULL OR last_code ~ '^[a-z0-9_]{1,64}$'),
  slack_ts varchar(40),
  acknowledged_at timestamptz,
  acknowledged_by_email varchar(320),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_slack_claim_shape CHECK (
    (status = 'SENDING' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'SENDING' AND claim_token IS NULL AND claimed_at IS NULL)
  ),
  CONSTRAINT operations_slack_receipt_shape CHECK (
    (status = 'SENT' AND slack_ts IS NOT NULL AND slack_ts ~ '^[0-9]{1,20}\.[0-9]{6}$')
    OR (status <> 'SENT' AND slack_ts IS NULL)
  ),
  CONSTRAINT operations_slack_acknowledgement_shape CHECK (
    (acknowledged_at IS NULL AND acknowledged_by_email IS NULL)
    OR (acknowledged_at IS NOT NULL AND acknowledged_by_email IS NOT NULL
      AND length(btrim(acknowledged_by_email)) > 0 AND status IN ('FAILED', 'UNCERTAIN'))
  )
);
CREATE INDEX operations_slack_notification_status_next_attempt_at_idx
  ON app.operations_slack_notification(status, next_attempt_at);

REVOKE ALL ON app.operations_slack_notification FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT SELECT, INSERT ON app.operations_slack_notification TO app_rw;
GRANT UPDATE (status, attempts, next_attempt_at, claim_token, claimed_at, last_code, slack_ts, updated_at)
  ON app.operations_slack_notification TO app_rw;
ALTER TABLE app.operations_slack_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operations_slack_notification FORCE ROW LEVEL SECURITY;

CREATE POLICY operations_slack_ops_read ON app.operations_slack_notification
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND nullif(current_setting('app.user_email', true), '') IS NOT NULL
  );
CREATE POLICY operations_slack_live_capture ON app.operations_slack_notification
  FOR INSERT TO app_rw WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND status = 'PENDING' AND attempts = 0 AND last_code IS NULL AND acknowledged_at IS NULL
    AND EXISTS (
      SELECT 1 FROM app.operations_fee_request request
      JOIN app.operations_fee_request_event event ON event.request_id = request.id
      WHERE request.id = operations_slack_notification.request_id
        AND event.id = operations_slack_notification.event_id
        AND event.action = 'SUBMITTED' AND event.to_status = 'PENDING'
        AND request.status = 'PENDING' AND request.legacy_source IS NULL
        AND request.submission_key IS NOT NULL
        AND request.submitted_by_email = current_setting('app.user_email', true)
        AND event.actor_email = current_setting('app.user_email', true)
        AND request.created_at >= transaction_timestamp()
    )
  );
CREATE POLICY operations_slack_worker_update ON app.operations_slack_notification
  FOR UPDATE TO app_rw USING (
    current_setting('app.user_role', true) = 'OPERATIONS'
    AND current_setting('app.user_email', true) = 'operations-slack-delivery@system'
  ) WITH CHECK (
    current_setting('app.user_role', true) = 'OPERATIONS'
    AND current_setting('app.user_email', true) = 'operations-slack-delivery@system'
  );

-- Recovery is deliberately not granted to the application. An explicitly
-- approved migration-owner operation may acknowledge a reviewed issue, while
-- preserving its terminal state/receipt and never requeuing the message.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY operations_slack_owner_read ON app.operations_slack_notification FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY operations_slack_owner_review ON app.operations_slack_notification FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Terminal/uncertain records cannot be silently requeued by the runtime role.
-- A repair is a separately reviewed administrative action with Slack evidence.
CREATE FUNCTION app.protect_operations_slack_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operations_slack_identity_immutable';
  END IF;
  IF current_user <> 'app_rw' AND OLD.status IN ('FAILED', 'UNCERTAIN')
    AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL
    AND (to_jsonb(NEW) - 'acknowledged_at' - 'acknowledged_by_email' - 'updated_at')
      = (to_jsonb(OLD) - 'acknowledged_at' - 'acknowledged_by_email' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
    OR NEW.acknowledged_by_email IS DISTINCT FROM OLD.acknowledged_by_email THEN
    RAISE EXCEPTION 'operations_slack_acknowledgement_denied';
  END IF;
  IF OLD.status IN ('PENDING', 'RETRY') AND NEW.status = 'SENDING'
    AND NEW.attempts = OLD.attempts + 1 AND OLD.attempts < 5
    AND OLD.next_attempt_at <= now() THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'SENDING' AND NEW.status IN ('SENT', 'RETRY', 'FAILED', 'UNCERTAIN')
    AND NEW.attempts = OLD.attempts THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'operations_slack_transition_invalid';
END;
$$;
REVOKE ALL ON FUNCTION app.protect_operations_slack_transition() FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
CREATE TRIGGER operations_slack_transition_guard BEFORE UPDATE ON app.operations_slack_notification
  FOR EACH ROW EXECUTE FUNCTION app.protect_operations_slack_transition();

-- Deliberately no backfill. Existing requests/imported history are never queued.
COMMIT;
