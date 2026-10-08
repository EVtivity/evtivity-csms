-- Scheduled fleet invoice run (fleet account billing, slice S9). The setting
-- fleet.invoiceRunDay (1 to 28, default 1) is the day of the month, in
-- the system timezone, from which the run invoices the previous month for
-- every fleet with auto_invoice. The fleet-invoice-run cron runs hourly: it
-- enqueues the fleets not invoiced yet and sends the overdue notices.
-- ON CONFLICT DO NOTHING keeps an operator value; idempotent.

INSERT INTO "settings" ("key", "value") VALUES ('fleet.invoiceRunDay', '1'::jsonb)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO cronjobs (name, schedule, status, next_run_at)
SELECT 'fleet-invoice-run', '15 * * * *', 'pending', NOW()
WHERE NOT EXISTS (SELECT 1 FROM cronjobs WHERE name = 'fleet-invoice-run');
