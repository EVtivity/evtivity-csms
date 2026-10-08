-- Prepaid notices: the low credit threshold setting (cents of the company
-- currency, 0 turns the notice off) and the station screen message shown when
-- the CSMS stops a session at its prepaid credit, in the six display
-- languages. ON CONFLICT DO NOTHING keeps operator values and edits.
INSERT INTO "settings" ("key", "value") VALUES ('prepaid.lowCreditThresholdCents', '500'::jsonb)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "station_message_templates" ("state", "language", "body") VALUES
  ('prepaid_exhausted', 'en', E'Prepaid credit used up.\nCharging stopped.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('prepaid_exhausted', 'de', E'Prepaid-Guthaben aufgebraucht.\nLaden beendet.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('prepaid_exhausted', 'es', E'Saldo prepago agotado.\nCarga detenida.\n{{#if supportPhone}}Soporte: {{supportPhone}}{{/if}}'),
  ('prepaid_exhausted', 'ko', E'선불 잔액이 소진되었습니다.\n충전이 중지되었습니다.\n{{#if supportPhone}}고객센터: {{supportPhone}}{{/if}}'),
  ('prepaid_exhausted', 'zh', E'预付余额已用完。\n充电已停止。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}'),
  ('prepaid_exhausted', 'zh-TW', E'預付餘額已用完。\n充電已停止。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}')
ON CONFLICT ("state", "language") DO NOTHING;
