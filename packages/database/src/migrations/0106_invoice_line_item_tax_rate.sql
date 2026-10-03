-- Invoice line items record the tax rate they were taxed at, so an invoice can
-- state its net amount, tax rate, and tax amount per rate (GitHub issue #33).
-- Existing line items get the tax rate snapshotted on their session (0 without
-- a session or rate). Single-session invoices used to carry their tax as a
-- separate "Tax" line item next to net-only lines. That tax moves onto the
-- first line item of the same invoice and session, and the "Tax" line item is
-- deleted, so every line item holds its net amount (total_cents) and its tax
-- (tax_cents). Invoice totals do not change.
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "tax_rate" numeric;
--> statement-breakpoint
UPDATE "invoice_line_items" li
SET "tax_rate" = COALESCE(cs."tariff_tax_rate", 0)
FROM "charging_sessions" cs
WHERE li."tax_rate" IS NULL AND cs."id" = li."session_id";
--> statement-breakpoint
UPDATE "invoice_line_items" SET "tax_rate" = 0 WHERE "tax_rate" IS NULL;
--> statement-breakpoint
WITH tax_lines AS (
	SELECT t."id", t."tax_cents",
		(
			SELECT min(n."id") FROM "invoice_line_items" n
			WHERE n."invoice_id" = t."invoice_id"
				AND n."session_id" IS NOT DISTINCT FROM t."session_id"
				AND NOT (n."description" = 'Tax' AND n."tax_cents" = n."total_cents" AND n."tax_cents" > 0)
		) AS "target_id"
	FROM "invoice_line_items" t
	WHERE t."description" = 'Tax' AND t."tax_cents" = t."total_cents" AND t."tax_cents" > 0
),
moved AS (
	UPDATE "invoice_line_items" li
	SET "tax_cents" = li."tax_cents" + tl."tax_cents"
	FROM tax_lines tl
	WHERE li."id" = tl."target_id"
	RETURNING tl."id" AS "tax_line_id"
)
DELETE FROM "invoice_line_items" WHERE "id" IN (SELECT "tax_line_id" FROM moved);
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ALTER COLUMN "tax_rate" SET NOT NULL;
