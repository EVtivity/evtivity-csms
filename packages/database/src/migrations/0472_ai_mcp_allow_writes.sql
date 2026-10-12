-- MCP writes are a setting (v0.1.45): ai.mcp.allowWrites, off by default, lets
-- MCP write tools run directly under the API key's own permissions and site
-- scope. It replaces the MCP write proposals of v0.1.44 (decision D7), so the
-- MCP proposal TTL, the MCP proposals and the proposal statuses of the MCP
-- call log go. The tables are locked first: a v0.1.44 pod that still serves
-- MCP during a rolling upgrade cannot add a row the new checks refuse between
-- the delete and the check. requested_by_user_id, api_key_id and
-- ai_mcp_calls.proposal_id stay until v0.1.46 (v0.1.44 pods insert them).
-- Idempotent.
LOCK TABLE "ai_proposals", "ai_mcp_calls" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES ('ai.mcp.allowWrites', 'false'::jsonb)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
DELETE FROM "settings" WHERE "key" = 'ai.mcp.proposalTtlMinutes';--> statement-breakpoint
DROP INDEX IF EXISTS "uq_ai_mcp_calls_delivered_proposal";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_ai_mcp_calls_proposal";--> statement-breakpoint
DELETE FROM "ai_mcp_calls" WHERE "status" NOT IN ('ok', 'error', 'refused');--> statement-breakpoint
ALTER TABLE "ai_mcp_calls" DROP CONSTRAINT IF EXISTS "ai_mcp_calls_status_check";--> statement-breakpoint
ALTER TABLE "ai_mcp_calls" ADD CONSTRAINT "ai_mcp_calls_status_check"
  CHECK ("status" IN ('ok', 'error', 'refused'));--> statement-breakpoint
DELETE FROM "ai_proposals" WHERE "source" = 'mcp';--> statement-breakpoint
ALTER TABLE "ai_proposals" DROP CONSTRAINT IF EXISTS "ai_proposals_source_check";--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_source_check"
  CHECK ("source" IN ('worker'));
