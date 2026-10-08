-- Fleet credit reservation (features/fleet-billing.md, S8): an account
-- session of a credit-limited fleet reserves a bounded slice of the fleet
-- credit at its start and grows its cost ceiling by another slice while it
-- charges. ON CONFLICT DO NOTHING keeps an operator value.
INSERT INTO "settings" ("key", "value") VALUES ('fleet.creditReservationCents', '5000'::jsonb)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- The cost ceiling last sent to an OCPP 2.1 station as transactionLimit.maxCost
-- (E16.FR.02): a grown ceiling differs from it and goes out once on the next
-- TransactionEventResponse. Null when the station never got a limit. Nullable
-- without a default, so the column is added without rewriting the table.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "cost_ceiling_sent_cents" integer;
