-- One-time CDR backfill: CDRs for completed roaming sessions that ended in the
-- 30 days before this migration ran (cutoff_at). One row; the OCPI server
-- advances the cursor and sets completed_at when it is done. A fresh install
-- gets the row too and finds nothing to backfill.
CREATE TABLE IF NOT EXISTS "ocpi_cdr_backfill" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "cutoff_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cursor_ended_at" timestamp with time zone,
  "cursor_session_id" text,
  "completed_at" timestamp with time zone,
  CONSTRAINT "ocpi_cdr_backfill_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "ocpi_cdr_backfill" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
