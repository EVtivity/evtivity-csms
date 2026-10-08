-- Timestamp of the meter reading that last raised a session's energy by 1 Wh
-- or more (ocpp/event-projections.md, flat-energy idle fallback). The fallback
-- opens an idle period only when the register stayed flat for a full sample
-- interval since then, so a clock-aligned or transaction-end sample sent a
-- moment after a periodic one opens none. Nullable without a default: the
-- column is added without rewriting the table, and a session without a value
-- counts from its start.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "energy_rose_at" timestamp with time zone;
