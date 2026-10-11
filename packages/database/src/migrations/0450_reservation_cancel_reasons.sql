-- Reservation hardening (v0.1.45, G4 and G16): two system cancel reasons.
-- station_no_response: the station never answered ReserveNow, so the hold is
-- cancelled without a fee. station_unavailable_during_hold: the station went
-- offline or faulted while it held the EVSE, so the driver could not use the
-- hold and pays no no-show fee (decision E12). Alone in its file, so the
-- values commit before a later file uses them. Idempotent.
ALTER TYPE "reservation_cancel_reason" ADD VALUE IF NOT EXISTS 'station_no_response';--> statement-breakpoint
ALTER TYPE "reservation_cancel_reason" ADD VALUE IF NOT EXISTS 'station_unavailable_during_hold';
