-- Personal AI configs (owner decision O4): effort replaces the sampling
-- settings (O2). NULL effort means the default (medium). Idempotent.
ALTER TABLE chatbot_ai_configs ADD COLUMN IF NOT EXISTS effort varchar(10);
--> statement-breakpoint
ALTER TABLE chatbot_ai_configs ADD COLUMN IF NOT EXISTS support_ai_effort varchar(10);
--> statement-breakpoint
ALTER TABLE chatbot_ai_configs
  DROP COLUMN IF EXISTS temperature,
  DROP COLUMN IF EXISTS top_p,
  DROP COLUMN IF EXISTS top_k,
  DROP COLUMN IF EXISTS support_ai_temperature,
  DROP COLUMN IF EXISTS support_ai_top_p,
  DROP COLUMN IF EXISTS support_ai_top_k;
