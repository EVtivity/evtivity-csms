-- Driver AI support (plan v0.1.45, section 2.4): audit actions of the AI
-- flow. Idempotent.
ALTER TYPE "support_case_audit_action" ADD VALUE IF NOT EXISTS 'ai_consent_granted';
--> statement-breakpoint
ALTER TYPE "support_case_audit_action" ADD VALUE IF NOT EXISTS 'ai_consent_declined';
--> statement-breakpoint
ALTER TYPE "support_case_audit_action" ADD VALUE IF NOT EXISTS 'ai_answered';
--> statement-breakpoint
ALTER TYPE "support_case_audit_action" ADD VALUE IF NOT EXISTS 'resolved_by_ai';
--> statement-breakpoint
ALTER TYPE "support_case_audit_action" ADD VALUE IF NOT EXISTS 'escalated_from_ai';
--> statement-breakpoint
ALTER TYPE "support_case_audit_action" ADD VALUE IF NOT EXISTS 'ai_failed';
