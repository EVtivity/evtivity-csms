-- Files attached to AI assistant chats (lane L3 of the AI upgrade). Written
-- only by the chat attachment service; the ai-retention-prune cron deletes the
-- S3 object before the row. Idempotent.
CREATE TABLE IF NOT EXISTS "ai_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"conversation_id" uuid,
	"status" varchar(16) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"declared_type" varchar(100) NOT NULL,
	"declared_size" integer NOT NULL,
	"content_type" varchar(100),
	"kind" varchar(16),
	"size_bytes" integer,
	"page_count" integer,
	"width" integer,
	"height" integer,
	"s3_bucket" varchar(255) NOT NULL,
	"quarantine_key" varchar(1024) NOT NULL,
	"s3_key" varchar(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ai_attachments_status_check" CHECK ("status" IN ('pending', 'ready')),
	CONSTRAINT "ai_attachments_kind_check" CHECK ("kind" IS NULL OR "kind" IN ('image', 'pdf', 'text'))
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ai_attachments" ADD CONSTRAINT "ai_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_attachments_user_created" ON "ai_attachments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_attachments_conversation" ON "ai_attachments" USING btree ("conversation_id");
