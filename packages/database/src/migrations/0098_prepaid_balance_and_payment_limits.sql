-- Prepaid credit per token (OCPP 2.1 C17). Null means the token is not
-- prepaid. A balance of zero or less is answered with NoCredit.
ALTER TABLE "driver_tokens" ADD COLUMN IF NOT EXISTS "prepaid_balance_cents" integer;
--> statement-breakpoint
-- Transaction limit of an ad hoc payment (OCPP 2.1 C24 and C25), returned to
-- the station in the TransactionEventResponse when the transaction starts.
ALTER TABLE "guest_sessions" ADD COLUMN IF NOT EXISTS "max_cost_cents" integer;
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN IF NOT EXISTS "max_energy_wh" integer;
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN IF NOT EXISTS "max_time_seconds" integer;
