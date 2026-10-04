-- Payments P4: indexes of the provider columns, built after the backfills in
-- their own file (SHARE lock: payment writes wait, reads continue). The
-- webhook_events unique index lets P8 swap the primary key to
-- (provider, event_id) without a rebuild.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_records_provider_payment_id_key" ON "payment_records" USING btree ("provider", "provider_payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_records_top_ups" ON "payment_records" USING gin (("metadata" -> 'topUps') jsonb_path_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_driver_payment_methods_driver_provider_method" ON "driver_payment_methods" USING btree ("driver_id", "provider", "provider_payment_method_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_driver_payment_methods_provider_method" ON "driver_payment_methods" USING btree ("provider", "provider_payment_method_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_driver_payment_methods_provider_customer" ON "driver_payment_methods" USING btree ("provider", "provider_customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_driver_payment_customers_provider_customer" ON "driver_payment_customers" USING btree ("provider", "provider_customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_site_payment_configs_payout_account_id" ON "site_payment_configs" USING btree ("payout_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_provider_event_id_key" ON "webhook_events" USING btree ("provider", "event_id");
--> statement-breakpoint
ANALYZE "payment_records";
--> statement-breakpoint
ANALYZE "driver_payment_methods";
--> statement-breakpoint
ANALYZE "driver_payment_customers";
