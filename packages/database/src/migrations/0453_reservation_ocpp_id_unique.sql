-- Reservation hardening (v0.1.45, G1 and decision E15): the OCPP reservation
-- id is unique on a station while the reservation is live, so the station and
-- the CSMS always mean the same hold. Ids come from reservation_id_seq, so a
-- duplicate can only exist after a sequence reset: the older live duplicates
-- are cancelled as system cleanup (no fee) before the index is built.
-- Idempotent.
UPDATE "reservations" r
SET "status" = 'cancelled',
    "cancelled_by" = 'system',
    "cancel_reason" = 'system_cleanup',
    "cancel_note" = 'duplicate live OCPP reservation id on the station',
    "updated_at" = now()
WHERE r."status" IN ('scheduled', 'active', 'in_use')
  AND EXISTS (
    SELECT 1 FROM "reservations" n
    WHERE n."station_id" = r."station_id"
      AND n."reservation_id" = r."reservation_id"
      AND n."status" IN ('scheduled', 'active', 'in_use')
      AND (n."created_at", n."id") > (r."created_at", r."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_reservations_station_ocpp_live" ON "reservations" ("station_id", "reservation_id") WHERE "status" IN ('scheduled', 'active', 'in_use');
