-- Invoice audit: the action 'invoice_sent', written when an invoice or credit
-- note email or SMS was accepted for delivery. Alone in its file, so the value
-- commits before a later file uses it. Idempotent.

ALTER TYPE "invoice_audit_action" ADD VALUE IF NOT EXISTS 'invoice_sent';
