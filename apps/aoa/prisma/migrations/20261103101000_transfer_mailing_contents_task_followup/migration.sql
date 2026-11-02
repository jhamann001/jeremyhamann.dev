-- ticket mockup fidelity: structured envelope contents on a mailing, and a
-- follow-up person and date on a task. Additive only. Both tables keep their
-- existing ENABLE + FORCE RLS, app_rw grants (no DELETE) and the
-- read_all_roles / insert_write_roles / update_write_roles policies; the new
-- columns inherit them.

ALTER TABLE "app"."transfer_mailing"
  ADD COLUMN "content_items" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "contents_note" text;

ALTER TABLE "app"."transfer_mailing"
  ADD CONSTRAINT "transfer_mailing_content_items_check"
    CHECK (content_items <@ ARRAY[
      'Empty Envelope', 'IRA Deposit Slip', 'Manual Transfer Paperwork', 'Signed transfer paperwork',
      'Return shipping label', 'General Mail', 'Estate Letter', 'Statement', 'Physical Check', 'Other'
    ]::text[]),
  ADD CONSTRAINT "transfer_mailing_contents_note_length_check"
    CHECK (contents_note IS NULL OR length(contents_note) <= 1000);

ALTER TABLE "app"."transfer_task"
  ADD COLUMN "assigned_to" text,
  ADD COLUMN "follow_up_on" date;

ALTER TABLE "app"."transfer_task"
  ADD CONSTRAINT "transfer_task_assigned_to_length_check"
    CHECK (assigned_to IS NULL OR length(assigned_to) BETWEEN 1 AND 100);
