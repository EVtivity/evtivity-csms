-- Backfill of the session end notice claims that 0250 added
-- (ocpp/event-projections.md). Its own file, so it takes row locks only and
-- 0250 holds ACCESS EXCLUSIVE for milliseconds (database.md, "Split an expand
-- by lock profile").
--
-- A session that ended in the last 30 days counts as notified: a station that
-- resends its Ended event for it gets the driver no second notice. Older
-- sessions are left alone, a station does not resend that late. A session
-- without ended_at falls back to updated_at for the window and to now() for
-- the stamp. Rerunning it touches only rows still unclaimed.
UPDATE "charging_sessions"
SET "completed_notified_at" = COALESCE("completed_notified_at", "ended_at", now()),
    "receipt_notified_at" = COALESCE("receipt_notified_at", "ended_at", now())
WHERE "status" <> 'active'
  AND COALESCE("ended_at", "updated_at") > now() - interval '30 days'
  AND ("completed_notified_at" IS NULL OR "receipt_notified_at" IS NULL);
