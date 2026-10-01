-- Operators invite operator-created drivers to the driver portal, and the
-- driver activates the invite by setting a password. Both are audited on the
-- driver. Idempotent.

DO $$
BEGIN
  ALTER TYPE driver_audit_action ADD VALUE IF NOT EXISTS 'portal_invited';
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TYPE driver_audit_action ADD VALUE IF NOT EXISTS 'portal_activated';
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;
