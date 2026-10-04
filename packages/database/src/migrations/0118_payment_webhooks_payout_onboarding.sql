-- Payments P3.5: payout account status of a site's connected account, the
-- site host onboarding invites, and the signing secret of the Stripe Connect
-- webhook endpoint. Existing site configs keep payout_account_status NULL
-- (unknown): the first use reads it from the provider.
ALTER TABLE "site_payment_configs" ADD COLUMN IF NOT EXISTS "payout_account_status" varchar(20);
--> statement-breakpoint
ALTER TABLE "site_payment_configs" ADD COLUMN IF NOT EXISTS "payout_account_details" jsonb;
--> statement-breakpoint
ALTER TABLE "site_payment_configs" ADD COLUMN IF NOT EXISTS "payout_account_checked_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "site_payment_configs" ADD CONSTRAINT "site_payment_configs_payout_account_status_check" CHECK ("payout_account_status" IS NULL OR "payout_account_status" IN ('onboarding', 'action_required', 'pending', 'active', 'disabled'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_payout_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"sent_to" varchar(255),
	"created_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "site_payout_invites" ADD CONSTRAINT "site_payout_invites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "site_payout_invites" ADD CONSTRAINT "site_payout_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_payout_invites_token_hash_key" ON "site_payout_invites" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_site_payout_invites_site_id" ON "site_payout_invites" USING btree ("site_id");
--> statement-breakpoint
INSERT INTO settings (key, value) VALUES ('stripe.connectWebhookSecretEnc', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
