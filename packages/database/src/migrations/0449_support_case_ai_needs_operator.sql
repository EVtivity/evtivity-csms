-- Driver AI support: whether the automatic answer said the support team is
-- needed, so the portal and the app show "We will pass this to the support
-- team if you choose No" only then. Null before an answer. Idempotent.
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_needs_operator" boolean;
