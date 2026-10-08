-- Fleet invoice (fleet account billing, slice S5): the invoice audit action
-- 'invoice_generated'. Alone in its file, so the value commits before a later
-- file uses it. Idempotent.

ALTER TYPE "invoice_audit_action" ADD VALUE IF NOT EXISTS 'invoice_generated';
