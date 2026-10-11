-- Reservation hardening (v0.1.45, G6): the expiry cron also activates
-- scheduled reservations whose start passed (a lost activation request), so
-- it looks them up by start time. Idempotent.
CREATE INDEX IF NOT EXISTS "idx_reservations_scheduled_starts_at" ON "reservations" ("starts_at") WHERE "status" = 'scheduled';
