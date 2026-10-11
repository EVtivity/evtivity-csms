-- Reservation insights (v0.1.45, plan 2026-10-11 section 4.3): the reservation
-- an insight is about, and the subject type 'reservation'. The insight goes
-- with its reservation (ON DELETE CASCADE). Idempotent.
ALTER TABLE "ai_insights" ADD COLUMN IF NOT EXISTS "reservation_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_reservation_id_reservations_id_fk"
    FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_reservation" ON "ai_insights" ("reservation_id");
--> statement-breakpoint
ALTER TABLE "ai_insights" DROP CONSTRAINT IF EXISTS "ai_insights_subject_type_check";
--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_subject_type_check"
  CHECK ("subject_type" IN ('station', 'session', 'authorization', 'reservation', 'site', 'company'));
