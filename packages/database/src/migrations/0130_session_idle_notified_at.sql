-- The driver or guest gets one "vehicle stopped charging" notification per idle
-- period. idle_notified_at holds the idle_started_at the notification was sent
-- for; the dispatch claims it atomically, so two events of one idle period
-- (ChargingStateChanged and CostLimitReached, or repeated SuspendedEV) cannot
-- both notify. Metadata-only (nullable, no default).
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "idle_notified_at" timestamp with time zone;
