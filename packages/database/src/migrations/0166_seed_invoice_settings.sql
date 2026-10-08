-- Days from issue to the due date of a new invoice. ON CONFLICT DO NOTHING
-- keeps an operator value.
INSERT INTO "settings" ("key", "value") VALUES ('invoice.paymentTermsDays', '30'::jsonb)
ON CONFLICT ("key") DO NOTHING;
