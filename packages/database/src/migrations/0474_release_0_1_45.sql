-- v0.1.45: every schema and data change of the release, in one file.
--
-- One migration file per release. This file replaces the nineteen files the
-- v0.1.45 prereleases and the first v0.1.45 build shipped (0443 to 0447,
-- 0449 to 0454, 0458 to 0460, 0469 to 0473). Databases that applied those
-- files keep their rows in drizzle.__drizzle_migrations, run this file once
-- more (it has a new hash and a later journal `when`), and change nothing:
-- every statement is idempotent, and the three one-time data steps (the vote
-- seed of ai_insight_feedback, the AI Inbox proposal cleanup and the delete of
-- the insights stored before the single insight status) run only while the
-- schema they migrate from is still in place.
--
-- One transaction. The enum values added here are not used by any statement
-- of this file (PostgreSQL refuses a value in the transaction that added it).
-- The station credential scrub runs first: it takes row locks only, and the
-- ALTER TABLE statements after it hold their ACCESS EXCLUSIVE locks only from
-- there to the commit.

-- 1. Scrub station credentials stored before v0.1.45.
--
-- Until v0.1.45 the CSMS stored the station Basic Auth password in clear: the
-- 2.1 SetVariables SecurityCtrlr.BasicAuthPassword attributeValue, the 1.6
-- ChangeConfiguration AuthorizationKey value and the SetNetworkProfile
-- connectionData.basicAuthPassword, in the OCPP message log, the offline
-- command queue, domain events and the API access log. From v0.1.45 the
-- writers mask them (maskStationCredentials, @evtivity/lib/secret-config).
-- This step replaces the stored values with '[redacted]', with the same
-- name rule in SQL: a field named as a credential, and the value or
-- attributeValue of an entry whose key, name or variable.name is one.
--
-- Cost. Every table is read only where a credential can be, and a row is
-- walked only when its payload text holds a credential-shaped name ending in
-- password, secret, key, enc or credential right before a closing quote.
-- Only changed rows are written.
-- - ocpp_message_logs: the rows of the actions SetVariables, GetVariables,
--   ChangeConfiguration, GetConfiguration, SetNetworkProfile and NotifyReport
--   (idx_ocpp_message_logs_action), and the CALLRESULT rows logged without an
--   action that answer GetVariables or GetConfiguration (action IS NULL, same
--   index, then a jsonb key check). The second set reads every inbound
--   CALLRESULT row once: on a large log this is the longest step, one pass
--   over that share of the table. Heartbeats, meter values and transaction
--   events (action set, not listed) are never read.
-- - station_configurations: one pass over the variable names.
-- - offline_command_queue: one pass (small). A pending command that carries a
--   credential is failed, not masked: delivering '[redacted]' as the password
--   would lock the station out, and a late password change would not match
--   the stored hash.
-- - domain_events: the event types command.GetVariables,
--   command.GetConfiguration, command.Queued and ocpp.NotifyReport
--   (idx_domain_events_event_type).
-- - access_logs: the rows of the OCPP command routes (path /v1/ocpp/commands/),
--   one sequential pass over the path column.
-- Idempotent: a masked value stays '[redacted]', so a second run reads the
-- same rows and writes none. The helper functions are created and dropped
-- here.

CREATE OR REPLACE FUNCTION public.evtivity_0474_is_credential_name(name text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT name IS NOT NULL
    AND name ~ '^[A-Za-z0-9_.-]+$'
    AND name !~ '^(has|is|must|needs|should)[A-Z_]'
    AND regexp_replace(lower(name), '[_.-]', '', 'g')
      ~ '(password|passwd|passphrase|secret|(api|private|client|secret|hmac|signing|encryption|access|auth|authorization|master)key|accesskeyid|enc|credential|credentials)$'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.evtivity_0474_may_hold_credential(doc jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT doc IS NOT NULL
    AND doc::text ~* '([A-Za-z0-9_.-](key|keyid)|password|passwd|passphrase|secret|enc|credentials?)"'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.evtivity_0474_mask_credentials(doc jsonb, secret_entry boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry boolean;
  result jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  nk text;
BEGIN
  IF doc IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(doc) = 'array' THEN
    RETURN COALESCE(
      (SELECT jsonb_agg(public.evtivity_0474_mask_credentials(e, secret_entry) ORDER BY i)
         FROM jsonb_array_elements(doc) WITH ORDINALITY AS t(e, i)),
      '[]'::jsonb);
  END IF;
  IF jsonb_typeof(doc) <> 'object' THEN
    RETURN doc;
  END IF;
  entry := secret_entry
    OR (jsonb_typeof(doc -> 'key') = 'string' AND public.evtivity_0474_is_credential_name(doc ->> 'key'))
    OR (jsonb_typeof(doc -> 'name') = 'string' AND public.evtivity_0474_is_credential_name(doc ->> 'name'))
    OR (jsonb_typeof(doc #> '{variable,name}') = 'string'
        AND public.evtivity_0474_is_credential_name(doc #>> '{variable,name}'));
  FOR k, v IN SELECT key, value FROM jsonb_each(doc) LOOP
    nk := regexp_replace(lower(k), '[_.-]', '', 'g');
    IF ((jsonb_typeof(v) = 'string' AND v <> '""'::jsonb) OR jsonb_typeof(v) = 'number')
       AND (public.evtivity_0474_is_credential_name(k)
            OR (entry AND nk IN ('value', 'attributevalue'))) THEN
      result := result || jsonb_build_object(k, '[redacted]');
    ELSE
      result := result || jsonb_build_object(
        k, public.evtivity_0474_mask_credentials(v, entry AND nk = 'variableattribute'));
    END IF;
  END LOOP;
  RETURN result;
END
$$;
--> statement-breakpoint
UPDATE ocpp_message_logs AS l
SET payload = m.masked
FROM (
  SELECT id, public.evtivity_0474_mask_credentials(payload, false) AS masked, payload
  FROM ocpp_message_logs
  WHERE action IN ('SetVariables', 'GetVariables', 'ChangeConfiguration', 'GetConfiguration',
                   'SetNetworkProfile', 'NotifyReport')
    AND public.evtivity_0474_may_hold_credential(payload)
) AS m
WHERE l.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE ocpp_message_logs AS l
SET payload = m.masked
FROM (
  SELECT id, public.evtivity_0474_mask_credentials(payload, false) AS masked, payload
  FROM ocpp_message_logs
  WHERE action IS NULL
    AND message_type = 3
    AND (payload ? 'configurationKey' OR payload ? 'getVariableResult')
    AND public.evtivity_0474_may_hold_credential(payload)
) AS m
WHERE l.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE station_configurations
SET value = '[redacted]', updated_at = now()
WHERE value IS NOT NULL
  AND value NOT IN ('', '[redacted]')
  AND public.evtivity_0474_is_credential_name(variable);
--> statement-breakpoint
UPDATE offline_command_queue AS q
SET payload = m.masked,
    status = CASE WHEN q.status = 'pending' THEN 'failed'::offline_command_status ELSE q.status END,
    failed_reason = CASE
      WHEN q.status = 'pending' THEN 'A station credential change is not delivered from the offline queue'
      ELSE q.failed_reason
    END
FROM (
  SELECT id, public.evtivity_0474_mask_credentials(payload, false) AS masked, payload
  FROM offline_command_queue
  WHERE public.evtivity_0474_may_hold_credential(payload)
) AS m
WHERE q.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE domain_events AS d
SET payload = m.masked
FROM (
  SELECT id, public.evtivity_0474_mask_credentials(payload, false) AS masked, payload
  FROM domain_events
  WHERE event_type IN ('command.GetVariables', 'command.GetConfiguration', 'command.Queued',
                       'ocpp.NotifyReport')
    AND public.evtivity_0474_may_hold_credential(payload)
) AS m
WHERE d.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE access_logs AS a
SET metadata = m.masked
FROM (
  SELECT id, public.evtivity_0474_mask_credentials(metadata, false) AS masked, metadata
  FROM access_logs
  WHERE path LIKE '/v1/ocpp/commands/%'
    AND public.evtivity_0474_may_hold_credential(metadata)
) AS m
WHERE a.id = m.id AND m.masked IS DISTINCT FROM m.metadata;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.evtivity_0474_mask_credentials(jsonb, boolean);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.evtivity_0474_may_hold_credential(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.evtivity_0474_is_credential_name(text);
--> statement-breakpoint
-- 2. Settings: the driverAi surface of driver support analyses with its
-- per-driver limits, and the reservation insight switch. Driver support
-- starts off. Values match defaultSettings in seed.ts and AI_SETTING_DEFAULTS
-- in @evtivity/lib/ai-config. ON CONFLICT DO NOTHING keeps an operator value.
INSERT INTO "settings" ("key", "value") VALUES
  ('driverAi.enabled', 'false'::jsonb),
  ('driverAi.provider', '"anthropic"'::jsonb),
  ('driverAi.model', '""'::jsonb),
  ('driverAi.effort', '"low"'::jsonb),
  ('driverAi.systemPrompt', '""'::jsonb),
  ('driverAi.maxCasesPerDriverPerDay', '3'::jsonb),
  ('driverAi.feedbackTimeoutHours', '24'::jsonb),
  ('ai.budget.driverDailyTokens', '40000'::jsonb),
  ('ai.rateLimit.driverPerMinute', '2'::jsonb),
  ('aiInsights.reservation.enabled', 'true'::jsonb)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- 3. Driver AI support: a case the AI handles before operators see it, the
-- stored AI answer as a case message, and the audit actions of the AI flow.
ALTER TYPE "support_case_status" ADD VALUE IF NOT EXISTS 'ai_assist';
--> statement-breakpoint
ALTER TYPE "support_case_message_sender" ADD VALUE IF NOT EXISTS 'assistant';
--> statement-breakpoint
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
--> statement-breakpoint
-- The consent the driver gave per case (server time, language, notice
-- version), the state of the AI step, the action codes of the answer, whether
-- the answer said the support team is needed, and who resolved the case. Null
-- consent: the driver was not asked.
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent" varchar(10);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent_language" varchar(10);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_consent_notice_version" integer;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_state" varchar(20);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_state_reason" varchar(40);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_answered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_feedback_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_driver_actions" jsonb;
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "resolution_source" varchar(10);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD COLUMN IF NOT EXISTS "ai_needs_operator" boolean;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_ai_consent_check"
    CHECK ("ai_consent" IN ('granted', 'declined'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_ai_consent_fields_check"
    CHECK (
      ("ai_consent_at" IS NULL AND "ai_consent_language" IS NULL AND "ai_consent_notice_version" IS NULL)
      OR ("ai_consent_at" IS NOT NULL AND "ai_consent_language" IS NOT NULL AND "ai_consent_notice_version" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_ai_state_check"
    CHECK ("ai_state" IN ('queued', 'analyzing', 'awaiting_feedback', 'resolved_by_ai', 'escalated', 'failed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_resolution_source_check"
    CHECK ("resolution_source" IN ('operator', 'ai'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_cases_ai_state_open"
  ON "support_cases" ("ai_state", "created_at")
  WHERE "ai_state" IN ('queued', 'analyzing', 'awaiting_feedback');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_cases_driver_ai_consent"
  ON "support_cases" ("driver_id", "ai_consent_at")
  WHERE "ai_consent" = 'granted';
--> statement-breakpoint
-- The ledger records the driver a driver_support call ran for (the driver
-- daily budget) and the support case (provenance, no foreign key, like the
-- other provenance ids).
ALTER TABLE "ai_usage_ledger" ADD COLUMN IF NOT EXISTS "driver_id" text;
--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN IF NOT EXISTS "support_case_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_driver_id_drivers_id_fk"
    FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" DROP CONSTRAINT IF EXISTS "ai_usage_ledger_surface_check";
--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_surface_check"
  CHECK ("surface" IN ('chatbot', 'support', 'insight', 'insight_translation', 'worker', 'driver_support'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_usage_ledger_driver_occurred_at"
  ON "ai_usage_ledger" ("driver_id", "occurred_at");
--> statement-breakpoint
-- Every minute, queue again cases stuck in queued or analyzing, and escalate
-- cases whose driver did not answer the feedback question in time.
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'driver-ai-sweep', '* * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'driver-ai-sweep');
--> statement-breakpoint
-- 4. Reservation hardening.
--
-- Cancel reasons. station_no_response: the station never answered ReserveNow,
-- so the hold is cancelled without a fee. station_unavailable_during_hold: the
-- station went offline or faulted while it held the EVSE, so the driver pays
-- no no-show fee.
ALTER TYPE "reservation_cancel_reason" ADD VALUE IF NOT EXISTS 'station_no_response';
--> statement-breakpoint
ALTER TYPE "reservation_cancel_reason" ADD VALUE IF NOT EXISTS 'station_unavailable_during_hold';
--> statement-breakpoint
-- Audit actions for station rejections, failed station cancels, station
-- faults during a hold, fee charges and failures, a hold taken by another
-- driver, and scheduled activations. The reservation insights read them.
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'station_rejected';
--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'station_cancel_failed';
--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'station_faulted';
--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'fee_charged';
--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'fee_failed';
--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'taken_by_other';
--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'activated';
--> statement-breakpoint
-- station_ack_at: when the station accepted ReserveNow. A no-show fee is
-- charged only for a hold the station accepted. Reservations active when the
-- column is added were accepted under the earlier flow, so they get one and
-- no running hold loses its fee. The backfill runs only when the column is
-- created, never again.
--
-- no_show_fee_state: none (no fee), due (the expiry recorded a fee to
-- charge), charged, failed (the charge was declined or could not run),
-- waived (another driver used the EVSE). The expiry sets due in the same
-- statement as the status, so a crash before the charge leaves the fee for
-- the next cron run.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reservations'
      AND column_name = 'station_ack_at'
  ) THEN
    ALTER TABLE "reservations" ADD COLUMN "station_ack_at" timestamp with time zone;
    UPDATE "reservations" SET "station_ack_at" = "updated_at" WHERE "status" = 'active';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "no_show_fee_state" varchar(10) DEFAULT 'none' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reservations" ADD CONSTRAINT "reservations_no_show_fee_state_check"
    CHECK ("no_show_fee_state" IN ('none', 'due', 'charged', 'failed', 'waived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reservations_no_show_fee_due" ON "reservations" ("updated_at") WHERE "no_show_fee_state" = 'due';
--> statement-breakpoint
-- The OCPP reservation id is unique on a station while the reservation is
-- live, so the station and the CSMS always mean the same hold. Ids come from
-- reservation_id_seq, so a duplicate can only exist after a sequence reset:
-- the older live duplicates are cancelled as system cleanup (no fee) before
-- the index is built. Once the index exists no duplicate is left to cancel.
UPDATE "reservations" r
SET "status" = 'cancelled',
    "cancelled_by" = 'system',
    "cancel_reason" = 'system_cleanup',
    "cancel_note" = 'duplicate live OCPP reservation id on the station',
    "updated_at" = now()
WHERE r."status" IN ('scheduled', 'active', 'in_use')
  AND EXISTS (
    SELECT 1 FROM "reservations" n
    WHERE n."station_id" = r."station_id"
      AND n."reservation_id" = r."reservation_id"
      AND n."status" IN ('scheduled', 'active', 'in_use')
      AND (n."created_at", n."id") > (r."created_at", r."id")
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_reservations_station_ocpp_live" ON "reservations" ("station_id", "reservation_id") WHERE "status" IN ('scheduled', 'active', 'in_use');
--> statement-breakpoint
-- The expiry cron also activates scheduled reservations whose start passed (a
-- lost activation request), so it looks them up by start time.
CREATE INDEX IF NOT EXISTS "idx_reservations_scheduled_starts_at" ON "reservations" ("starts_at") WHERE "status" = 'scheduled';
--> statement-breakpoint
-- 5. AI insights and conversations.
--
-- The reservation an insight is about, and the subject type 'reservation'.
-- The insight goes with its reservation (ON DELETE CASCADE).
ALTER TABLE "ai_insights" ADD COLUMN IF NOT EXISTS "reservation_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_reservation_id_reservations_id_fk"
    FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insights_reservation" ON "ai_insights" ("reservation_id");
--> statement-breakpoint
ALTER TABLE "ai_insights" DROP CONSTRAINT IF EXISTS "ai_insights_subject_type_check";
--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_subject_type_check"
  CHECK ("subject_type" IN ('station', 'session', 'authorization', 'reservation', 'site', 'company'));
--> statement-breakpoint
-- Explain from a reservation and from an insight: the context kinds
-- 'reservation' (context_id is reservations.id) and 'insight' (ai_insights.id).
ALTER TABLE "ai_conversations" DROP CONSTRAINT IF EXISTS "ai_conversations_context_check";
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_context_check"
  CHECK (("context_kind" IS NULL AND "context_id" IS NULL)
    OR ("context_kind" IN ('station', 'session', 'authorization', 'reservation', 'insight') AND "context_id" IS NOT NULL));
--> statement-breakpoint
-- Insights no longer carry the all-sites (network) counts. Removes the stored
-- key; the site counts stay. A rerun finds no row with the key.
UPDATE "ai_insights" SET "scope" = "scope" - 'network' WHERE "scope" ? 'network';
--> statement-breakpoint
-- One vote per user and insight. Votes were audit rows only, one per click;
-- the latest vote of each user on each insight seeds the table when it is
-- created, never again (a rerun would bring back a vote the user cleared).
-- The reason is untrusted operator text, never sent to a model.
ALTER TYPE "ai_insight_audit_action" ADD VALUE IF NOT EXISTS 'feedback_cleared';
--> statement-breakpoint
-- A rejected action closes its insight `rejected`, audited as that, not as a
-- dismissal. Nothing in this file writes the value: a value added in a
-- transaction cannot be used before it commits.
ALTER TYPE "ai_insight_audit_action" ADD VALUE IF NOT EXISTS 'rejected';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.ai_insight_feedback') IS NULL THEN
    CREATE TABLE "public"."ai_insight_feedback" (
      "insight_id" text NOT NULL,
      "user_id" text NOT NULL,
      "helpful" boolean NOT NULL,
      "reason" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "uq_ai_insight_feedback_insight_user" UNIQUE ("insight_id", "user_id")
    );
    INSERT INTO "public"."ai_insight_feedback" ("insight_id", "user_id", "helpful", "created_at", "updated_at")
    SELECT DISTINCT ON (a."ai_insight_id", a."actor_user_id")
      a."ai_insight_id", a."actor_user_id", a."action" = 'feedback_helpful', a."created_at", a."created_at"
    FROM "ai_insight_audit_log" a
    JOIN "ai_insights" i ON i."id" = a."ai_insight_id"
    JOIN "users" u ON u."id" = a."actor_user_id"
    WHERE a."action" IN ('feedback_helpful', 'feedback_wrong')
    ORDER BY a."ai_insight_id", a."actor_user_id", a."created_at" DESC, a."id" DESC
    ON CONFLICT ("insight_id", "user_id") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insight_feedback" ADD CONSTRAINT "ai_insight_feedback_insight_id_ai_insights_id_fk"
    FOREIGN KEY ("insight_id") REFERENCES "public"."ai_insights"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_insight_feedback" ADD CONSTRAINT "ai_insight_feedback_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insight_feedback_user" ON "ai_insight_feedback" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_insight_feedback_updated" ON "ai_insight_feedback" ("updated_at");
--> statement-breakpoint
-- 6. MCP writes and insight actions.
--
-- The tables are locked first: a v0.1.44 pod that still serves MCP or the AI
-- Inbox during a rolling upgrade cannot add a row the new checks refuse
-- between a delete and the check or NOT NULL that follows it.
LOCK TABLE "ai_proposals", "ai_mcp_calls" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- MCP writes are a setting: ai.mcp.allowWrites, off by default, lets MCP
-- write tools run directly under the API key's own permissions and site
-- scope. It replaces the MCP write proposals of v0.1.44, so the MCP proposal
-- TTL, the MCP proposals and the proposal statuses of the MCP call log go.
-- requested_by_user_id, api_key_id and ai_mcp_calls.proposal_id stay until
-- v0.1.46 (v0.1.44 pods insert them). After the checks below a rerun finds
-- nothing to delete.
INSERT INTO "settings" ("key", "value") VALUES ('ai.mcp.allowWrites', 'false'::jsonb)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
DELETE FROM "settings" WHERE "key" = 'ai.mcp.proposalTtlMinutes';
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_ai_mcp_calls_delivered_proposal";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_ai_mcp_calls_proposal";
--> statement-breakpoint
DELETE FROM "ai_mcp_calls" WHERE "status" NOT IN ('ok', 'error', 'refused');
--> statement-breakpoint
ALTER TABLE "ai_mcp_calls" DROP CONSTRAINT IF EXISTS "ai_mcp_calls_status_check";
--> statement-breakpoint
ALTER TABLE "ai_mcp_calls" ADD CONSTRAINT "ai_mcp_calls_status_check"
  CHECK ("status" IN ('ok', 'error', 'refused'));
--> statement-breakpoint
DELETE FROM "ai_proposals" WHERE "source" = 'mcp';
--> statement-breakpoint
ALTER TABLE "ai_proposals" DROP CONSTRAINT IF EXISTS "ai_proposals_source_check";
--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_source_check"
  CHECK ("source" IN ('worker'));
--> statement-breakpoint
-- The AI Inbox merges into AI Insights: a background worker suggestion is now
-- an insight that carries an action (an ai_proposals row, one per insight).
-- No data migration: stored proposals that no worker action insight carries
-- are deleted, once, while insight_id is still nullable (the v0.1.44 schema);
-- a rerun keeps every live action. source (now defaulting to 'worker'),
-- requested_by_user_id, api_key_id, rationale_text and rationale_language
-- stay until v0.1.46 (v0.1.44 pods read and insert them).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ai_proposals'
      AND column_name = 'insight_id'
      AND is_nullable = 'YES'
  ) THEN
    DELETE FROM "ai_proposals" p
    WHERE p."insight_id" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "ai_insights" i
        WHERE i."id" = p."insight_id" AND i."kind" IN ('stuck_session', 'station_long_faulted')
      );
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "ai_proposals" ALTER COLUMN "source" SET DEFAULT 'worker';
--> statement-breakpoint
ALTER TABLE "ai_proposals" ALTER COLUMN "insight_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_insight_id_ai_insights_id_fk"
    FOREIGN KEY ("insight_id") REFERENCES "public"."ai_insights"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_proposals_insight" ON "ai_proposals" ("insight_id");
--> statement-breakpoint
-- The aiProposals:* permissions are removed from users, roles and API keys;
-- insight actions use aiInsights:*.
DELETE FROM "user_permissions" WHERE "permission" IN ('aiProposals:read', 'aiProposals:write');
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" - 'aiProposals:read' - 'aiProposals:write'
WHERE jsonb_typeof("permissions") = 'array'
  AND "permissions" ?| ARRAY['aiProposals:read', 'aiProposals:write'];
--> statement-breakpoint
UPDATE "refresh_tokens"
SET "permissions" = "permissions" - 'aiProposals:read' - 'aiProposals:write'
WHERE jsonb_typeof("permissions") = 'array'
  AND "permissions" ?| ARRAY['aiProposals:read', 'aiProposals:write'];
--> statement-breakpoint
-- 7. One insight status.
--
-- ai_insights.status is the one status of an insight and its action. Shown:
-- open, pending (its action waits for a decision), done (the action ran),
-- rejected (the action was rejected), resolved, dismissed, expired (the action
-- expired). Internal, never listed: analyzing (was pending), skipped, failed,
-- superseded.
--
-- No backfill (owner decision): the insights stored before it are deleted with
-- every row that hangs on them (actions and their audit, texts, votes, audit,
-- cooldowns, scan watermarks; the scan starts again from now). The delete runs
-- only while the old status check (with 'active') is in place: on a v0.1.44
-- database, on one that ran the earlier v0.1.45 files, and on a fresh install
-- (where it finds nothing). The check is replaced right after, so a rerun of
-- this file keeps every insight created since.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ai_insights'::regclass
      AND conname = 'ai_insights_status_check'
      AND pg_get_constraintdef(oid) LIKE '%''active''%'
  ) THEN
    DELETE FROM "ai_proposal_audit_log";
    DELETE FROM "ai_proposals";
    DELETE FROM "ai_insight_audit_log";
    DELETE FROM "ai_insight_texts";
    DELETE FROM "ai_insight_feedback";
    DELETE FROM "ai_insight_cooldowns";
    DELETE FROM "ai_insight_scan_state";
    DELETE FROM "ai_insights";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "ai_insights" DROP CONSTRAINT IF EXISTS "ai_insights_status_check";
--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_status_check"
  CHECK ("status" IN ('analyzing', 'skipped', 'failed', 'superseded', 'open', 'pending', 'done',
    'rejected', 'resolved', 'dismissed', 'expired'));
--> statement-breakpoint
ALTER TABLE "ai_insights" ALTER COLUMN "status" SET DEFAULT 'analyzing';
