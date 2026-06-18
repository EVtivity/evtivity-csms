CREATE TABLE IF NOT EXISTS "driver_push_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "driver_push_tokens" ADD CONSTRAINT "driver_push_tokens_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_driver_push_tokens_token" ON "driver_push_tokens" ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_driver_push_tokens_driver" ON "driver_push_tokens" ("driver_id");
--> statement-breakpoint
ALTER TABLE "driver_notification_preferences" ADD COLUMN IF NOT EXISTS "push_enabled" boolean DEFAULT true NOT NULL;
