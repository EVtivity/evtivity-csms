CREATE INDEX IF NOT EXISTS "idx_ocpp_message_logs_station_created_at" ON "ocpp_message_logs" ("station_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ocpp_message_logs_station_action" ON "ocpp_message_logs" ("station_id","action");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_ocpp_message_logs_station_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_port_status_log_station_timestamp" ON "port_status_log" ("station_id","timestamp");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_port_status_log_station_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connection_logs_station_created_at" ON "connection_logs" ("station_id","created_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_connection_logs_station_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_events_station_timestamp" ON "security_events" ("station_id","timestamp");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_security_events_station_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_station_events_station_generated_at" ON "station_events" ("station_id","generated_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_station_events_station_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_authorize_attempts_station_created_at" ON "authorize_attempts" ("station_id","created_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_authorize_attempts_station_id";
