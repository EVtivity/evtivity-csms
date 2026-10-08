-- Durable claims of the session end notices (ocpp/event-projections.md):
-- session.Completed and session.Receipt go out only from the projection run
-- that set the column (UPDATE ... WHERE <col> IS NULL RETURNING), so a station
-- that resends its Ended event gets the driver no second notice. Nullable
-- without a default, so the columns are added without rewriting the table.
-- The backfill of sessions that ended before this release is 0252 (row locks
-- only), so this file holds ACCESS EXCLUSIVE for milliseconds.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "completed_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "receipt_notified_at" timestamp with time zone;
