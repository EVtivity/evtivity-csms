-- A durable request to end an active session the normal way (completed,
-- priced, settled, receipt) when the station will not end it: a ghost session
-- (TxNotFound) the operator stopped, or a session superseded on its EVSE.
-- end_request_reason is set by the requester (the API or the OCPP projection);
-- end_claimed_at is the lease of the OCPP pod processing it, so the OCPP sweep
-- retries a request whose pub/sub message was lost or whose pod died.
-- end_attempts counts the claims; after the cap the sweep faults the session
-- unbilled (EndRequestFailed) instead of retrying forever. The stale-session
-- cleanup skips sessions with a request.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "end_request_reason" varchar(32);
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "end_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "end_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_charging_sessions_end_request" ON "charging_sessions" ("end_request_reason") WHERE "status" = 'active' AND "end_request_reason" IS NOT NULL;
