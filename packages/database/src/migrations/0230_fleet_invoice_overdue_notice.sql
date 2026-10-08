-- Scheduled fleet invoice run (fleet account billing, slice S9). An issued
-- fleet invoice past its due date and unpaid sends invoice.FleetOverdue to the
-- fleet billing contacts once: overdue_notice_sent_at is the claim, set before
-- the send. Nullable metadata on a small table, idempotent.

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "overdue_notice_sent_at" timestamp with time zone;
