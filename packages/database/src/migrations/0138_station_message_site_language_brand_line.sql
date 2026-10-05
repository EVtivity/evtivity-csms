-- Per-site station display language: NULL follows the stationMessage.language
-- setting.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "station_message_language" varchar(10);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sites" ADD CONSTRAINT "sites_station_message_language_check"
    CHECK ("station_message_language" IN ('en', 'de', 'es', 'ko', 'zh', 'zh-TW'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- The state screens start with the brand line ({{brandLine}}: the
-- stationMessage.brandLine setting, else the company name). Only templates
-- still equal to the previous default change; operator edits stay.
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}incl.{{else}}excl.{{/if}} {{taxRatePercent}}% tax\n{{/if}}Plug in to start', "updated_at" = now()
WHERE "state" = 'available' AND "language" = 'en' AND "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}incl.{{else}}excl.{{/if}} {{taxRatePercent}}% tax\n{{/if}}Plug in to start';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\nTap card or open app\nto start charging', "updated_at" = now()
WHERE "state" = 'occupied' AND "language" = 'en' AND "body" = E'{{stationOcppId}}\nTap card or open app\nto start charging';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nReserved\n{{#if driverFirstName}}for {{driverFirstName}}{{/if}}\nuntil {{reservationExpiresAt}}', "updated_at" = now()
WHERE "state" = 'reserved' AND "language" = 'en' AND "body" = E'Reserved\n{{#if driverFirstName}}for {{driverFirstName}}{{/if}}\nuntil {{reservationExpiresAt}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nCharging\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'en' AND "body" = E'Charging\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nCharging paused\n{{#if idleFeeRate}}Idle fee {{idleFeeRate}} after grace{{/if}}', "updated_at" = now()
WHERE "state" = 'suspended' AND "language" = 'en' AND "body" = E'Charging paused\n{{#if idleFeeRate}}Idle fee {{idleFeeRate}} after grace{{/if}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nDischarging to grid\n{{energyKwh}} kWh sent\n{{costFormatted}}', "updated_at" = now()
WHERE "state" = 'discharging' AND "language" = 'en' AND "body" = E'Discharging to grid\n{{energyKwh}} kWh sent\n{{costFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nStation fault\nContact support\n{{supportPhone}}', "updated_at" = now()
WHERE "state" = 'faulted' AND "language" = 'en' AND "body" = E'Station fault\nContact support\n{{supportPhone}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nTemporarily unavailable', "updated_at" = now()
WHERE "state" = 'unavailable' AND "language" = 'en' AND "body" = E'Temporarily unavailable\n{{companyName}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}inkl.{{else}}zzgl.{{/if}} {{taxRatePercent}} % MwSt.\n{{/if}}Zum Starten einstecken', "updated_at" = now()
WHERE "state" = 'available' AND "language" = 'de' AND "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}inkl.{{else}}zzgl.{{/if}} {{taxRatePercent}} % MwSt.\n{{/if}}Zum Starten einstecken';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\nKarte vorhalten oder\nApp öffnen zum Laden', "updated_at" = now()
WHERE "state" = 'occupied' AND "language" = 'de' AND "body" = E'{{stationOcppId}}\nKarte vorhalten oder\nApp öffnen zum Laden';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nReserviert\n{{#if driverFirstName}}für {{driverFirstName}}{{/if}}\nbis {{reservationExpiresAt}}', "updated_at" = now()
WHERE "state" = 'reserved' AND "language" = 'de' AND "body" = E'Reserviert\n{{#if driverFirstName}}für {{driverFirstName}}{{/if}}\nbis {{reservationExpiresAt}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nLädt\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'de' AND "body" = E'Lädt\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nLaden pausiert\n{{#if idleFeeRate}}Standgebühr {{idleFeeRate}} nach Karenzzeit{{/if}}', "updated_at" = now()
WHERE "state" = 'suspended' AND "language" = 'de' AND "body" = E'Laden pausiert\n{{#if idleFeeRate}}Standgebühr {{idleFeeRate}} nach Karenzzeit{{/if}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nRückspeisung ins Netz\n{{energyKwh}} kWh abgegeben\n{{costFormatted}}', "updated_at" = now()
WHERE "state" = 'discharging' AND "language" = 'de' AND "body" = E'Rückspeisung ins Netz\n{{energyKwh}} kWh abgegeben\n{{costFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nStörung\nSupport kontaktieren\n{{supportPhone}}', "updated_at" = now()
WHERE "state" = 'faulted' AND "language" = 'de' AND "body" = E'Störung\nSupport kontaktieren\n{{supportPhone}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nVorübergehend nicht verfügbar', "updated_at" = now()
WHERE "state" = 'unavailable' AND "language" = 'de' AND "body" = E'Vorübergehend nicht verfügbar\n{{companyName}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}Impuestos incluidos{{else}}Impuestos no incluidos{{/if}} ({{taxRatePercent}} %)\n{{/if}}Conecte para iniciar', "updated_at" = now()
WHERE "state" = 'available' AND "language" = 'es' AND "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}Impuestos incluidos{{else}}Impuestos no incluidos{{/if}} ({{taxRatePercent}} %)\n{{/if}}Conecte para iniciar';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\nAcerque su tarjeta o\nabra la app para cargar', "updated_at" = now()
WHERE "state" = 'occupied' AND "language" = 'es' AND "body" = E'{{stationOcppId}}\nAcerque su tarjeta o\nabra la app para cargar';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nReservado\n{{#if driverFirstName}}para {{driverFirstName}}{{/if}}\nhasta {{reservationExpiresAt}}', "updated_at" = now()
WHERE "state" = 'reserved' AND "language" = 'es' AND "body" = E'Reservado\n{{#if driverFirstName}}para {{driverFirstName}}{{/if}}\nhasta {{reservationExpiresAt}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nCargando\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'es' AND "body" = E'Cargando\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nCarga en pausa\n{{#if idleFeeRate}}Tarifa por inactividad {{idleFeeRate}} tras el periodo de gracia{{/if}}', "updated_at" = now()
WHERE "state" = 'suspended' AND "language" = 'es' AND "body" = E'Carga en pausa\n{{#if idleFeeRate}}Tarifa por inactividad {{idleFeeRate}} tras el periodo de gracia{{/if}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nDescargando a la red\n{{energyKwh}} kWh enviados\n{{costFormatted}}', "updated_at" = now()
WHERE "state" = 'discharging' AND "language" = 'es' AND "body" = E'Descargando a la red\n{{energyKwh}} kWh enviados\n{{costFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nFallo en la estación\nContacte con soporte\n{{supportPhone}}', "updated_at" = now()
WHERE "state" = 'faulted' AND "language" = 'es' AND "body" = E'Fallo en la estación\nContacte con soporte\n{{supportPhone}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\nNo disponible temporalmente', "updated_at" = now()
WHERE "state" = 'unavailable' AND "language" = 'es' AND "body" = E'No disponible temporalmente\n{{companyName}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}세금 {{taxRatePercent}}% 포함{{else}}세금 {{taxRatePercent}}% 별도{{/if}}\n{{/if}}플러그를 연결하여 시작', "updated_at" = now()
WHERE "state" = 'available' AND "language" = 'ko' AND "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}세금 {{taxRatePercent}}% 포함{{else}}세금 {{taxRatePercent}}% 별도{{/if}}\n{{/if}}플러그를 연결하여 시작';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n카드를 태그하거나\n앱에서 충전을 시작하세요', "updated_at" = now()
WHERE "state" = 'occupied' AND "language" = 'ko' AND "body" = E'{{stationOcppId}}\n카드를 태그하거나\n앱에서 충전을 시작하세요';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n예약됨\n{{#if driverFirstName}}{{driverFirstName}}님{{/if}}\n{{reservationExpiresAt}}까지', "updated_at" = now()
WHERE "state" = 'reserved' AND "language" = 'ko' AND "body" = E'예약됨\n{{#if driverFirstName}}{{driverFirstName}}님{{/if}}\n{{reservationExpiresAt}}까지';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n충전 중\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'ko' AND "body" = E'충전 중\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n충전 일시 중지\n{{#if idleFeeRate}}유예 시간 후 유휴 요금 {{idleFeeRate}}{{/if}}', "updated_at" = now()
WHERE "state" = 'suspended' AND "language" = 'ko' AND "body" = E'충전 일시 중지\n{{#if idleFeeRate}}유예 시간 후 유휴 요금 {{idleFeeRate}}{{/if}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n전력망으로 방전 중\n{{energyKwh}} kWh 송전\n{{costFormatted}}', "updated_at" = now()
WHERE "state" = 'discharging' AND "language" = 'ko' AND "body" = E'전력망으로 방전 중\n{{energyKwh}} kWh 송전\n{{costFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n충전기 고장\n고객센터에 문의하세요\n{{supportPhone}}', "updated_at" = now()
WHERE "state" = 'faulted' AND "language" = 'ko' AND "body" = E'충전기 고장\n고객센터에 문의하세요\n{{supportPhone}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n일시적으로 사용 불가', "updated_at" = now()
WHERE "state" = 'unavailable' AND "language" = 'ko' AND "body" = E'일시적으로 사용 불가\n{{companyName}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含税{{else}}不含税{{/if}}（税率 {{taxRatePercent}}%）\n{{/if}}插枪即可开始充电', "updated_at" = now()
WHERE "state" = 'available' AND "language" = 'zh' AND "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含税{{else}}不含税{{/if}}（税率 {{taxRatePercent}}%）\n{{/if}}插枪即可开始充电';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n请刷卡或打开应用\n开始充电', "updated_at" = now()
WHERE "state" = 'occupied' AND "language" = 'zh' AND "body" = E'{{stationOcppId}}\n请刷卡或打开应用\n开始充电';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n已预约\n{{#if driverFirstName}}预约人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}', "updated_at" = now()
WHERE "state" = 'reserved' AND "language" = 'zh' AND "body" = E'已预约\n{{#if driverFirstName}}预约人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n充电中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'zh' AND "body" = E'充电中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n充电已暂停\n{{#if idleFeeRate}}宽限期后收取占位费 {{idleFeeRate}}{{/if}}', "updated_at" = now()
WHERE "state" = 'suspended' AND "language" = 'zh' AND "body" = E'充电已暂停\n{{#if idleFeeRate}}宽限期后收取占位费 {{idleFeeRate}}{{/if}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n正在向电网放电\n已放电 {{energyKwh}} kWh\n{{costFormatted}}', "updated_at" = now()
WHERE "state" = 'discharging' AND "language" = 'zh' AND "body" = E'正在向电网放电\n已放电 {{energyKwh}} kWh\n{{costFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n充电桩故障\n请联系客服\n{{supportPhone}}', "updated_at" = now()
WHERE "state" = 'faulted' AND "language" = 'zh' AND "body" = E'充电桩故障\n请联系客服\n{{supportPhone}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n暂时无法使用', "updated_at" = now()
WHERE "state" = 'unavailable' AND "language" = 'zh' AND "body" = E'暂时无法使用\n{{companyName}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含稅{{else}}未稅{{/if}}（稅率 {{taxRatePercent}}%）\n{{/if}}插槍即可開始充電', "updated_at" = now()
WHERE "state" = 'available' AND "language" = 'zh-TW' AND "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含稅{{else}}未稅{{/if}}（稅率 {{taxRatePercent}}%）\n{{/if}}插槍即可開始充電';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n{{stationOcppId}}\n請感應卡片或開啟 App\n開始充電', "updated_at" = now()
WHERE "state" = 'occupied' AND "language" = 'zh-TW' AND "body" = E'{{stationOcppId}}\n請感應卡片或開啟 App\n開始充電';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n已預約\n{{#if driverFirstName}}預約人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}', "updated_at" = now()
WHERE "state" = 'reserved' AND "language" = 'zh-TW' AND "body" = E'已預約\n{{#if driverFirstName}}預約人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n充電中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}', "updated_at" = now()
WHERE "state" = 'charging' AND "language" = 'zh-TW' AND "body" = E'充電中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n充電已暫停\n{{#if idleFeeRate}}寬限期後收取佔位費 {{idleFeeRate}}{{/if}}', "updated_at" = now()
WHERE "state" = 'suspended' AND "language" = 'zh-TW' AND "body" = E'充電已暫停\n{{#if idleFeeRate}}寬限期後收取佔位費 {{idleFeeRate}}{{/if}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n正在向電網放電\n已放電 {{energyKwh}} kWh\n{{costFormatted}}', "updated_at" = now()
WHERE "state" = 'discharging' AND "language" = 'zh-TW' AND "body" = E'正在向電網放電\n已放電 {{energyKwh}} kWh\n{{costFormatted}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n充電樁故障\n請聯絡客服\n{{supportPhone}}', "updated_at" = now()
WHERE "state" = 'faulted' AND "language" = 'zh-TW' AND "body" = E'充電樁故障\n請聯絡客服\n{{supportPhone}}';
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{brandLine}}\n暫時無法使用', "updated_at" = now()
WHERE "state" = 'unavailable' AND "language" = 'zh-TW' AND "body" = E'暫時無法使用\n{{companyName}}';
