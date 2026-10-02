-- Count of notApplicable tests per OCTT run, and the PICS item and reason that
-- exclude each notApplicable test. Idempotent.
ALTER TABLE "octt_runs" ADD COLUMN IF NOT EXISTS "not_applicable" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "octt_test_results" ADD COLUMN IF NOT EXISTS "not_applicable_item" varchar(100);
--> statement-breakpoint
ALTER TABLE "octt_test_results" ADD COLUMN IF NOT EXISTS "not_applicable_reason" text;
