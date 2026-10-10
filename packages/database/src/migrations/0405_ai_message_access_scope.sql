-- AI assistant: the access fingerprint (sites plus effective permissions) of
-- the caller that produced a tool message. Reads and replays hide the tool
-- results of a message whose fingerprint differs from the current caller's.
-- Null on rows written before this column: treated as a different access.
-- Idempotent.

ALTER TABLE "ai_messages" ADD COLUMN IF NOT EXISTS "access_scope" varchar(32);
