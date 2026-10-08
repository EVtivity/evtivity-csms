-- Indexes for the sessions and reservation fee charges an invoice claimed
-- (void release, invoice delete). Each takes a SHARE lock: reads continue,
-- writes wait. 0165 validates the foreign keys of 0162. Idempotent.

CREATE INDEX IF NOT EXISTS "idx_sessions_invoice_id" ON "charging_sessions" ("invoice_id") WHERE invoice_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_records_invoice_id" ON "payment_records" ("invoice_id") WHERE invoice_id IS NOT NULL;--> statement-breakpoint
ANALYZE "charging_sessions";--> statement-breakpoint
ANALYZE "payment_records";
