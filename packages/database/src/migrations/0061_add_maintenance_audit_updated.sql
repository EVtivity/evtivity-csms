-- Add 'updated' to the maintenance_event_audit_action enum so PATCH of a
-- scheduled maintenance event can write a real audit row. Idempotent.

DO $$
BEGIN
  ALTER TYPE maintenance_event_audit_action ADD VALUE IF NOT EXISTS 'updated' BEFORE 'started';
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;
