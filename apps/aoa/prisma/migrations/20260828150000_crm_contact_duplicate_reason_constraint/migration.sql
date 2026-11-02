-- Allow the contact-specific confirmation reason introduced with contact
-- duplicate review. The review function already restricts this reason to
-- CONTACT candidates; this table constraint remains the final controlled-value
-- boundary for every duplicate outcome.

BEGIN;

ALTER TABLE app.crm_duplicate_candidate
  DROP CONSTRAINT crm_duplicate_candidate_reason_controlled,
  ADD CONSTRAINT crm_duplicate_candidate_reason_controlled CHECK (
    decision_reason IS NULL OR decision_reason IN (
      'SAME_RELATIONSHIP_SOURCE_DUPLICATE',
      'SAME_PERSON_SOURCE_DUPLICATE',
      'OFFICIAL_SOURCE_REPLACEMENT',
      'SHARED_IDENTIFIER_CONFIRMED',
      'DISTINCT_PEOPLE_OR_HOUSEHOLDS',
      'DISTINCT_ACCOUNTS',
      'SOURCE_DATA_ERROR'
    )
  );

COMMIT;
