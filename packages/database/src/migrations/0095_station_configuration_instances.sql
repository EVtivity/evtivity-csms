-- A station configuration row is identified by its component instance and
-- variable instance too, so DeviceDataCtrlr.ItemsPerMessage[GetReport] and
-- ItemsPerMessage[GetVariables] are stored as separate rows.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_station_configurations_identity" ON "station_configurations" USING btree ("station_id","component",COALESCE(instance, ''),"variable",COALESCE(variable_instance, ''),COALESCE(evse_id, -1),COALESCE(connector_id, -1),"attribute_type");
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_station_configurations_composite";
