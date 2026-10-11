-- Scrub station credentials stored before v0.1.45.
--
-- Until v0.1.45 the CSMS stored the station Basic Auth password in clear: the
-- 2.1 SetVariables SecurityCtrlr.BasicAuthPassword attributeValue, the 1.6
-- ChangeConfiguration AuthorizationKey value and the SetNetworkProfile
-- connectionData.basicAuthPassword, in the OCPP message log, the offline
-- command queue, domain events and the API access log. From v0.1.45 the
-- writers mask them (maskStationCredentials, @evtivity/lib/secret-config).
-- This migration replaces the stored values with '[redacted]', with the same
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
-- Idempotent: a masked value stays '[redacted]', so a second run writes no
-- row. The helper functions are created and dropped by this migration.

CREATE OR REPLACE FUNCTION public.evtivity_0470_is_credential_name(name text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT name IS NOT NULL
    AND name ~ '^[A-Za-z0-9_.-]+$'
    AND name !~ '^(has|is|must|needs|should)[A-Z_]'
    AND regexp_replace(lower(name), '[_.-]', '', 'g')
      ~ '(password|passwd|passphrase|secret|(api|private|client|secret|hmac|signing|encryption|access|auth|authorization|master)key|accesskeyid|enc|credential|credentials)$'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.evtivity_0470_may_hold_credential(doc jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT doc IS NOT NULL
    AND doc::text ~* '([A-Za-z0-9_.-](key|keyid)|password|passwd|passphrase|secret|enc|credentials?)"'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.evtivity_0470_mask_credentials(doc jsonb, secret_entry boolean)
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
      (SELECT jsonb_agg(public.evtivity_0470_mask_credentials(e, secret_entry) ORDER BY i)
         FROM jsonb_array_elements(doc) WITH ORDINALITY AS t(e, i)),
      '[]'::jsonb);
  END IF;
  IF jsonb_typeof(doc) <> 'object' THEN
    RETURN doc;
  END IF;
  entry := secret_entry
    OR (jsonb_typeof(doc -> 'key') = 'string' AND public.evtivity_0470_is_credential_name(doc ->> 'key'))
    OR (jsonb_typeof(doc -> 'name') = 'string' AND public.evtivity_0470_is_credential_name(doc ->> 'name'))
    OR (jsonb_typeof(doc #> '{variable,name}') = 'string'
        AND public.evtivity_0470_is_credential_name(doc #>> '{variable,name}'));
  FOR k, v IN SELECT key, value FROM jsonb_each(doc) LOOP
    nk := regexp_replace(lower(k), '[_.-]', '', 'g');
    IF ((jsonb_typeof(v) = 'string' AND v <> '""'::jsonb) OR jsonb_typeof(v) = 'number')
       AND (public.evtivity_0470_is_credential_name(k)
            OR (entry AND nk IN ('value', 'attributevalue'))) THEN
      result := result || jsonb_build_object(k, '[redacted]');
    ELSE
      result := result || jsonb_build_object(
        k, public.evtivity_0470_mask_credentials(v, entry AND nk = 'variableattribute'));
    END IF;
  END LOOP;
  RETURN result;
END
$$;
--> statement-breakpoint
UPDATE ocpp_message_logs AS l
SET payload = m.masked
FROM (
  SELECT id, public.evtivity_0470_mask_credentials(payload, false) AS masked, payload
  FROM ocpp_message_logs
  WHERE action IN ('SetVariables', 'GetVariables', 'ChangeConfiguration', 'GetConfiguration',
                   'SetNetworkProfile', 'NotifyReport')
    AND public.evtivity_0470_may_hold_credential(payload)
) AS m
WHERE l.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE ocpp_message_logs AS l
SET payload = m.masked
FROM (
  SELECT id, public.evtivity_0470_mask_credentials(payload, false) AS masked, payload
  FROM ocpp_message_logs
  WHERE action IS NULL
    AND message_type = 3
    AND (payload ? 'configurationKey' OR payload ? 'getVariableResult')
    AND public.evtivity_0470_may_hold_credential(payload)
) AS m
WHERE l.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE station_configurations
SET value = '[redacted]', updated_at = now()
WHERE value IS NOT NULL
  AND value NOT IN ('', '[redacted]')
  AND public.evtivity_0470_is_credential_name(variable);
--> statement-breakpoint
UPDATE offline_command_queue AS q
SET payload = m.masked,
    status = CASE WHEN q.status = 'pending' THEN 'failed'::offline_command_status ELSE q.status END,
    failed_reason = CASE
      WHEN q.status = 'pending' THEN 'A station credential change is not delivered from the offline queue'
      ELSE q.failed_reason
    END
FROM (
  SELECT id, public.evtivity_0470_mask_credentials(payload, false) AS masked, payload
  FROM offline_command_queue
  WHERE public.evtivity_0470_may_hold_credential(payload)
) AS m
WHERE q.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE domain_events AS d
SET payload = m.masked
FROM (
  SELECT id, public.evtivity_0470_mask_credentials(payload, false) AS masked, payload
  FROM domain_events
  WHERE event_type IN ('command.GetVariables', 'command.GetConfiguration', 'command.Queued',
                       'ocpp.NotifyReport')
    AND public.evtivity_0470_may_hold_credential(payload)
) AS m
WHERE d.id = m.id AND m.masked IS DISTINCT FROM m.payload;
--> statement-breakpoint
UPDATE access_logs AS a
SET metadata = m.masked
FROM (
  SELECT id, public.evtivity_0470_mask_credentials(metadata, false) AS masked, metadata
  FROM access_logs
  WHERE path LIKE '/v1/ocpp/commands/%'
    AND public.evtivity_0470_may_hold_credential(metadata)
) AS m
WHERE a.id = m.id AND m.masked IS DISTINCT FROM m.metadata;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.evtivity_0470_mask_credentials(jsonb, boolean);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.evtivity_0470_may_hold_credential(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.evtivity_0470_is_credential_name(text);
