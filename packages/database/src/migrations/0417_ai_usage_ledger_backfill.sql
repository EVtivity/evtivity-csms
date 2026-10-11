-- AI usage ledger backfill: one ledger row per stored assistant message with
-- usage, so the budgets keep counting the usage before the ledger existed.
-- Surface and user come from the conversation, the site from the support
-- case's station (null for the chatbot and for a case without a station).
-- Messages do not store their model: the conversation's latest provider and
-- model stand in. A message that already has a ledger row is skipped, so a
-- rerun adds nothing. Turns that pods of the previous release run between
-- this migration and their replacement write no ledger row and are not
-- counted. Idempotent.

INSERT INTO "ai_usage_ledger" (
  "occurred_at", "surface", "user_id", "site_id", "conversation_id", "ai_message_id",
  "provider", "model", "input_tokens", "cached_read_tokens", "cache_write_tokens",
  "output_tokens", "reasoning_tokens", "cost_micros"
)
SELECT
  m."created_at",
  c."surface",
  c."user_id",
  cs."site_id",
  c."id",
  m."id",
  c."provider",
  c."model",
  GREATEST(COALESCE((m."usage"->>'inputTokens')::bigint, 0), 0)::integer,
  GREATEST(COALESCE((m."usage"->>'cachedReadTokens')::bigint, 0), 0)::integer,
  GREATEST(COALESCE((m."usage"->>'cacheWriteTokens')::bigint, 0), 0)::integer,
  GREATEST(COALESCE((m."usage"->>'outputTokens')::bigint, 0), 0)::integer,
  GREATEST(COALESCE((m."usage"->>'reasoningTokens')::bigint, 0), 0)::integer,
  m."cost_micros"
FROM "ai_messages" m
JOIN "ai_conversations" c ON c."id" = m."conversation_id"
LEFT JOIN "support_cases" sc ON sc."id" = c."support_case_id"
LEFT JOIN "charging_stations" cs ON cs."id" = sc."station_id"
WHERE m."role" = 'assistant'
  AND m."usage" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ai_usage_ledger" l WHERE l."ai_message_id" = m."id"
  );
