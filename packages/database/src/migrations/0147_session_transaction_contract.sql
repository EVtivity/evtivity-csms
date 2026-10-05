-- N4 contract: transactionIds are unique per station only (OCPP 2.1 E01.FR.08).
-- 0143 (v0.1.38) added uq_charging_sessions_station_transaction and kept the
-- global unique and the plain index for pods before v0.1.38, which insert with
-- ON CONFLICT (transaction_id). Every install runs v0.1.38 first, so both go.
ALTER TABLE "charging_sessions" DROP CONSTRAINT IF EXISTS "charging_sessions_transaction_id_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sessions_transaction_id";
