-- N4 expand: transactionIds are unique per station (OCPP 2.1 E01.FR.08). The
-- global charging_sessions_transaction_id_unique and idx_sessions_transaction_id
-- stay: pods before v0.1.38 insert with ON CONFLICT (transaction_id). The N4
-- contract (release after v0.1.38) drops them. The runner applies each file in
-- one transaction, so the index cannot be built CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_charging_sessions_station_transaction" ON "charging_sessions" USING btree ("station_id","transaction_id");
