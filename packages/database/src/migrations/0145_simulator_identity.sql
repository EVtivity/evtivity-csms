-- Simulator identity (a real station connecting as a simulator-flagged one).
-- css_stations.marker_seen_at: first connection of the simulator with its
-- marker header, proof that it owns the identity. charging_stations
-- .simulator_conflict_at: last connection the OCPP server could not attribute
-- to the simulator, for the operator to confirm. Idempotent.

ALTER TABLE css_stations ADD COLUMN IF NOT EXISTS marker_seen_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE charging_stations ADD COLUMN IF NOT EXISTS simulator_conflict_at timestamp with time zone;
