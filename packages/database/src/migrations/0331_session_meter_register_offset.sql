-- Energy register rebase per session (finding B10). A transaction's
-- ".Register" values increase monotonically except when the meter is
-- replaced (OCPP 2.1 J02.FR.16 and MeasurandEnumType note 2, OCPP 1.6
-- section 7.31). The CSMS keeps the newest register reading it projected and
-- its timestamp: a reading older than it never changes the session energy,
-- and a newer reading below it is a meter reset or replacement, so the drop
-- is added to meter_register_offset_wh and the energy delivered so far is
-- kept. Session energy is register + offset - meter_start. Idempotent.
ALTER TABLE charging_sessions
  ADD COLUMN IF NOT EXISTS meter_register_offset_wh numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE charging_sessions
  ADD COLUMN IF NOT EXISTS meter_last_register_wh numeric;
--> statement-breakpoint
ALTER TABLE charging_sessions
  ADD COLUMN IF NOT EXISTS meter_last_register_at timestamp with time zone;
