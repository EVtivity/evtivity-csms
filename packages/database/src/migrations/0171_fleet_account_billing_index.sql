-- Indexes for fleet account billing: the sessions billed to a fleet (the
-- foreign key check on fleet delete, the open billing check) and the unbilled
-- account sessions of a fleet (the fleet invoice). Each takes a SHARE lock:
-- reads continue, writes wait. 0172 validates the checks and the foreign key
-- of 0170. Idempotent.

CREATE INDEX IF NOT EXISTS "idx_sessions_billing_fleet_id" ON "charging_sessions" ("billing_fleet_id") WHERE billing_fleet_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_account_unbilled" ON "charging_sessions" ("billing_fleet_id") WHERE billing_mode = 'account' AND invoice_id IS NULL;--> statement-breakpoint
ANALYZE "charging_sessions";
