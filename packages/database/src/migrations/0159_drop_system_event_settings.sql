-- System notifications are always on (owner decision 2026-10-06). Since
-- v0.1.40 dispatch never reads system_event_settings, and the GET and PUT
-- /v1/system-event-settings routes that wrote it are removed. Drop the table
-- (its unique constraint goes with it). Upgrade through v0.1.40: v0.1.39 pods
-- read this table during dispatch. Idempotent.
DROP TABLE IF EXISTS "system_event_settings";
