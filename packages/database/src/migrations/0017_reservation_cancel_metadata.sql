-- Add cancel-actor / cancel-reason / cancel-note / cancellation-fee metadata
-- to reservations. Drives the new actor-aware fee logic:
--   driver  -> always charges per cancellation-window settings
--   operator -> charges only when the operator opts in on the cancel request
--   system   -> never charges; reason captures why (station rejected, expired,
--               etc.)
--
-- Existing cancelled rows are intentionally NOT backfilled. We don't have
-- enough history to reliably attribute who cancelled them or what fee (if
-- any) was charged at the time, so the new columns stay NULL/0 for the past.

DO $$ BEGIN
  CREATE TYPE reservation_cancelled_by AS ENUM ('driver', 'operator', 'system');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE reservation_cancel_reason AS ENUM (
    'driver_initiated',
    'operator_manual',
    'expired_no_show',
    'station_rejected_occupied',
    'station_rejected_other',
    'station_offline_at_activation',
    'system_cleanup'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS cancelled_by reservation_cancelled_by,
  ADD COLUMN IF NOT EXISTS cancel_reason reservation_cancel_reason,
  ADD COLUMN IF NOT EXISTS cancel_note text,
  ADD COLUMN IF NOT EXISTS cancellation_fee_cents integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_reservations_driver_id ON reservations (driver_id);
