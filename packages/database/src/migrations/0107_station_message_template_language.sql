-- Station message templates per display language (stationMessage.language).
-- Existing rows are the English templates. The English Available default gains
-- the tax note (taxRatePercent, pricesIncludeTax) unless the operator edited it.
-- All six languages are seeded for every state, which also gives installs that
-- never ran the seed script their state templates. ON CONFLICT DO NOTHING keeps
-- operator edits.
ALTER TABLE "station_message_templates" ADD COLUMN IF NOT EXISTS "language" varchar(10);
--> statement-breakpoint
UPDATE "station_message_templates" SET "language" = 'en' WHERE "language" IS NULL;
--> statement-breakpoint
ALTER TABLE "station_message_templates" ALTER COLUMN "language" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "station_message_templates" DROP CONSTRAINT IF EXISTS "station_message_templates_state_unique";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "station_message_templates" ADD CONSTRAINT "uq_station_message_templates_state_language" UNIQUE ("state", "language");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
UPDATE "station_message_templates"
SET "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}incl.{{else}}excl.{{/if}} {{taxRatePercent}}% tax\n{{/if}}Plug in to start', "updated_at" = now()
WHERE "state" = 'available' AND "language" = 'en' AND "body" = E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\nPlug in to start';
--> statement-breakpoint
INSERT INTO "station_message_templates" ("state", "language", "body") VALUES
  ('available', 'en', E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}incl.{{else}}excl.{{/if}} {{taxRatePercent}}% tax\n{{/if}}Plug in to start'),
  ('occupied', 'en', E'{{stationOcppId}}\nTap card or open app\nto start charging'),
  ('reserved', 'en', E'Reserved\n{{#if driverFirstName}}for {{driverFirstName}}{{/if}}\nuntil {{reservationExpiresAt}}'),
  ('charging', 'en', E'Charging\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}'),
  ('suspended', 'en', E'Charging paused\n{{#if idleFeeRate}}Idle fee {{idleFeeRate}} after grace{{/if}}'),
  ('discharging', 'en', E'Discharging to grid\n{{energyKwh}} kWh sent\n{{costFormatted}}'),
  ('faulted', 'en', E'Station fault\nContact support\n{{supportPhone}}'),
  ('unavailable', 'en', E'Temporarily unavailable\n{{companyName}}'),
  ('payment_failed', 'en', E'Payment declined.\nUpdate your card in the app and try again.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('payment_required', 'en', E'Add a payment method\nin the app to start charging.\n{{companyName}}'),
  ('guest_unauthorized', 'en', E'Guest payment not authorized.\nScan the QR code\nto restart checkout.'),
  ('unauthorized', 'en', E'Tap your RFID card\nor scan the QR code\nto authorize charging.'),
  ('available', 'de', E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}inkl.{{else}}zzgl.{{/if}} {{taxRatePercent}} % MwSt.\n{{/if}}Zum Starten einstecken'),
  ('occupied', 'de', E'{{stationOcppId}}\nKarte vorhalten oder\nApp öffnen zum Laden'),
  ('reserved', 'de', E'Reserviert\n{{#if driverFirstName}}für {{driverFirstName}}{{/if}}\nbis {{reservationExpiresAt}}'),
  ('charging', 'de', E'Lädt\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}'),
  ('suspended', 'de', E'Laden pausiert\n{{#if idleFeeRate}}Standgebühr {{idleFeeRate}} nach Karenzzeit{{/if}}'),
  ('discharging', 'de', E'Rückspeisung ins Netz\n{{energyKwh}} kWh abgegeben\n{{costFormatted}}'),
  ('faulted', 'de', E'Störung\nSupport kontaktieren\n{{supportPhone}}'),
  ('unavailable', 'de', E'Vorübergehend nicht verfügbar\n{{companyName}}'),
  ('payment_failed', 'de', E'Zahlung abgelehnt.\nKarte in der App aktualisieren und erneut versuchen.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('payment_required', 'de', E'Zahlungsmittel in der App\nhinzufügen, um zu laden.\n{{companyName}}'),
  ('guest_unauthorized', 'de', E'Gastzahlung nicht autorisiert.\nQR-Code scannen,\num neu zu starten.'),
  ('unauthorized', 'de', E'RFID-Karte vorhalten\noder QR-Code scannen,\num das Laden freizugeben.'),
  ('available', 'es', E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}Impuestos incluidos{{else}}Impuestos no incluidos{{/if}} ({{taxRatePercent}} %)\n{{/if}}Conecte para iniciar'),
  ('occupied', 'es', E'{{stationOcppId}}\nAcerque su tarjeta o\nabra la app para cargar'),
  ('reserved', 'es', E'Reservado\n{{#if driverFirstName}}para {{driverFirstName}}{{/if}}\nhasta {{reservationExpiresAt}}'),
  ('charging', 'es', E'Cargando\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}'),
  ('suspended', 'es', E'Carga en pausa\n{{#if idleFeeRate}}Tarifa por inactividad {{idleFeeRate}} tras el periodo de gracia{{/if}}'),
  ('discharging', 'es', E'Descargando a la red\n{{energyKwh}} kWh enviados\n{{costFormatted}}'),
  ('faulted', 'es', E'Fallo en la estación\nContacte con soporte\n{{supportPhone}}'),
  ('unavailable', 'es', E'No disponible temporalmente\n{{companyName}}'),
  ('payment_failed', 'es', E'Pago rechazado.\nActualice su tarjeta en la app e inténtelo de nuevo.\n{{#if supportPhone}}Soporte: {{supportPhone}}{{/if}}'),
  ('payment_required', 'es', E'Añada un método de pago\nen la app para cargar.\n{{companyName}}'),
  ('guest_unauthorized', 'es', E'Pago de invitado no autorizado.\nEscanee el código QR\npara reiniciar el pago.'),
  ('unauthorized', 'es', E'Acerque su tarjeta RFID\no escanee el código QR\npara autorizar la carga.'),
  ('available', 'ko', E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}세금 {{taxRatePercent}}% 포함{{else}}세금 {{taxRatePercent}}% 별도{{/if}}\n{{/if}}플러그를 연결하여 시작'),
  ('occupied', 'ko', E'{{stationOcppId}}\n카드를 태그하거나\n앱에서 충전을 시작하세요'),
  ('reserved', 'ko', E'예약됨\n{{#if driverFirstName}}{{driverFirstName}}님{{/if}}\n{{reservationExpiresAt}}까지'),
  ('charging', 'ko', E'충전 중\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}'),
  ('suspended', 'ko', E'충전 일시 중지\n{{#if idleFeeRate}}유예 시간 후 유휴 요금 {{idleFeeRate}}{{/if}}'),
  ('discharging', 'ko', E'전력망으로 방전 중\n{{energyKwh}} kWh 송전\n{{costFormatted}}'),
  ('faulted', 'ko', E'충전기 고장\n고객센터에 문의하세요\n{{supportPhone}}'),
  ('unavailable', 'ko', E'일시적으로 사용 불가\n{{companyName}}'),
  ('payment_failed', 'ko', E'결제가 거절되었습니다.\n앱에서 카드를 업데이트한 후 다시 시도하세요.\n{{#if supportPhone}}고객센터: {{supportPhone}}{{/if}}'),
  ('payment_required', 'ko', E'충전하려면 앱에서\n결제 수단을 추가하세요.\n{{companyName}}'),
  ('guest_unauthorized', 'ko', E'게스트 결제가 승인되지 않았습니다.\nQR 코드를 스캔하여\n결제를 다시 시작하세요.'),
  ('unauthorized', 'ko', E'RFID 카드를 태그하거나\nQR 코드를 스캔하여\n충전을 승인하세요.'),
  ('available', 'zh', E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含税{{else}}不含税{{/if}}（税率 {{taxRatePercent}}%）\n{{/if}}插枪即可开始充电'),
  ('occupied', 'zh', E'{{stationOcppId}}\n请刷卡或打开应用\n开始充电'),
  ('reserved', 'zh', E'已预约\n{{#if driverFirstName}}预约人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}'),
  ('charging', 'zh', E'充电中\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}'),
  ('suspended', 'zh', E'充电已暂停\n{{#if idleFeeRate}}宽限期后收取占位费 {{idleFeeRate}}{{/if}}'),
  ('discharging', 'zh', E'正在向电网放电\n已放电 {{energyKwh}} kWh\n{{costFormatted}}'),
  ('faulted', 'zh', E'充电桩故障\n请联系客服\n{{supportPhone}}'),
  ('unavailable', 'zh', E'暂时无法使用\n{{companyName}}'),
  ('payment_failed', 'zh', E'支付被拒绝。\n请在应用中更新银行卡后重试。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}'),
  ('payment_required', 'zh', E'请在应用中添加\n支付方式后充电。\n{{companyName}}'),
  ('guest_unauthorized', 'zh', E'访客支付未获授权。\n请扫描二维码\n重新结账。'),
  ('unauthorized', 'zh', E'请刷 RFID 卡\n或扫描二维码\n授权充电。'),
  ('available', 'zh-TW', E'{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含稅{{else}}未稅{{/if}}（稅率 {{taxRatePercent}}%）\n{{/if}}插槍即可開始充電'),
  ('occupied', 'zh-TW', E'{{stationOcppId}}\n請感應卡片或開啟 App\n開始充電'),
  ('reserved', 'zh-TW', E'已預約\n{{#if driverFirstName}}預約人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}'),
  ('charging', 'zh-TW', E'充電中\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}'),
  ('suspended', 'zh-TW', E'充電已暫停\n{{#if idleFeeRate}}寬限期後收取佔位費 {{idleFeeRate}}{{/if}}'),
  ('discharging', 'zh-TW', E'正在向電網放電\n已放電 {{energyKwh}} kWh\n{{costFormatted}}'),
  ('faulted', 'zh-TW', E'充電樁故障\n請聯絡客服\n{{supportPhone}}'),
  ('unavailable', 'zh-TW', E'暫時無法使用\n{{companyName}}'),
  ('payment_failed', 'zh-TW', E'付款遭拒。\n請在 App 中更新信用卡後重試。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}'),
  ('payment_required', 'zh-TW', E'請在 App 中新增\n付款方式後充電。\n{{companyName}}'),
  ('guest_unauthorized', 'zh-TW', E'訪客付款未獲授權。\n請掃描 QR 碼\n重新結帳。'),
  ('unauthorized', 'zh-TW', E'請感應 RFID 卡\n或掃描 QR 碼\n授權充電。')
ON CONFLICT ("state", "language") DO NOTHING;
