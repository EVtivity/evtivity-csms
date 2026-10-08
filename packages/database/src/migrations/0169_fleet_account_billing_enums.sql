-- Fleet account billing: the fleet audit actions 'billing_updated' (the
-- fleet's account billing switch) and 'member_billing_opt_out_changed' (a
-- member's opt-out back to card). Alone in their file, so the values commit
-- before a later file uses them. Idempotent.

ALTER TYPE "fleet_audit_action" ADD VALUE IF NOT EXISTS 'billing_updated';--> statement-breakpoint
ALTER TYPE "fleet_audit_action" ADD VALUE IF NOT EXISTS 'member_billing_opt_out_changed';
