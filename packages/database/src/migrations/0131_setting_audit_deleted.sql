-- Add 'deleted' to the setting_audit_action enum. DELETE /v1/settings/:key
-- writes an audit row with action 'deleted', which the enum (only 'updated')
-- rejected, so writeAudit logged a warning and the row was lost. Idempotent.

DO $$
BEGIN
  ALTER TYPE setting_audit_action ADD VALUE IF NOT EXISTS 'deleted';
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;
