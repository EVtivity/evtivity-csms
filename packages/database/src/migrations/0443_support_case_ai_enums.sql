-- Driver AI support (plan v0.1.45, section 2.4): a case the AI handles
-- before operators see it, and the stored AI answer as a case message. Each
-- ADD VALUE commits before 0444 uses it (per-file transactions). Idempotent.
ALTER TYPE "support_case_status" ADD VALUE IF NOT EXISTS 'ai_assist';
--> statement-breakpoint
ALTER TYPE "support_case_message_sender" ADD VALUE IF NOT EXISTS 'assistant';
