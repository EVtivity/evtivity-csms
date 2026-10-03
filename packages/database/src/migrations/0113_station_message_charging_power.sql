-- The charging screen shows the power only when the station reports it, so a
-- station without a power reading no longer shows "0,0 kWh /  kW". Only
-- templates still equal to the previous default change; operator edits stay.
UPDATE "station_message_templates"
SET "body" = E'Charging\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'en' AND "body" = E'Charging\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'Lädt\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'de' AND "body" = E'Lädt\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'Cargando\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'es' AND "body" = E'Cargando\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'충전 중\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'ko' AND "body" = E'충전 중\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'充电中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'zh' AND "body" = E'充电中\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'充電中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'zh-TW' AND "body" = E'充電中\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}';
