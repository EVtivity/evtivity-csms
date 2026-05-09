DROP INDEX "idx_config_templates_station";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_config_templates_station" ON "config_templates" USING btree ("station_id");