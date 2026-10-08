-- Claims every session and reservation fee charge already on a non-void
-- invoice for that invoice (the oldest one when on two). What is only on void
-- invoices stays unclaimed, so it can be invoiced again. Row locks only,
-- idempotent: a claimed row is never changed.

UPDATE "charging_sessions" cs
SET "invoice_id" = claimed."invoice_id"
FROM (
  SELECT DISTINCT ON (li."session_id") li."session_id", li."invoice_id"
  FROM "invoice_line_items" li
  JOIN "invoices" i ON i."id" = li."invoice_id"
  WHERE li."session_id" IS NOT NULL AND i."status" <> 'void'
  ORDER BY li."session_id", i."created_at", i."id"
) claimed
WHERE cs."id" = claimed."session_id" AND cs."invoice_id" IS NULL;--> statement-breakpoint
UPDATE "payment_records" pr
SET "invoice_id" = claimed."invoice_id"
FROM (
  SELECT DISTINCT ON (li."payment_record_id") li."payment_record_id", li."invoice_id"
  FROM "invoice_line_items" li
  JOIN "invoices" i ON i."id" = li."invoice_id"
  WHERE li."payment_record_id" IS NOT NULL AND i."status" <> 'void'
  ORDER BY li."payment_record_id", i."created_at", i."id"
) claimed
WHERE pr."id" = claimed."payment_record_id" AND pr."invoice_id" IS NULL;
