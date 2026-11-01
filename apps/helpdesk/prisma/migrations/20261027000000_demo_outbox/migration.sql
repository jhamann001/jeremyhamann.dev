-- Demo only (NEXT_PUBLIC_DEMO_MODE=on): what the stand-ins received in place of the mail sender and Slack.
CREATE TABLE "DemoOutboxMessage" (
    "id" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "deliveryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoOutboxMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DemoOutboxMessage_deliveryId_key" ON "DemoOutboxMessage"("deliveryId");

CREATE INDEX "DemoOutboxMessage_createdAt_idx" ON "DemoOutboxMessage"("createdAt");

-- Append-only, like the other record tables: what the stand-ins received is not edited afterwards. The
-- nightly reset (prisma/demo-reset.ts) switches these off with every other trigger to empty the table.
DROP TRIGGER IF EXISTS demo_outbox_message_no_update_delete ON "DemoOutboxMessage";
CREATE TRIGGER demo_outbox_message_no_update_delete
  BEFORE UPDATE OR DELETE ON "DemoOutboxMessage"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS demo_outbox_message_no_truncate ON "DemoOutboxMessage";
CREATE TRIGGER demo_outbox_message_no_truncate
  BEFORE TRUNCATE ON "DemoOutboxMessage"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- The client-facing role never reads it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN
    REVOKE ALL ON "DemoOutboxMessage" FROM wm_helpdesk_public;
  END IF;
END $$;
