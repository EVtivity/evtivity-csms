-- Credit notes: the invoice status 'credited' and the invoice audit action
-- 'invoice_credited'. Alone in their file, so the values commit before a later
-- file uses them. Idempotent.

ALTER TYPE "invoice_status" ADD VALUE IF NOT EXISTS 'credited';--> statement-breakpoint
ALTER TYPE "invoice_audit_action" ADD VALUE IF NOT EXISTS 'invoice_credited';
